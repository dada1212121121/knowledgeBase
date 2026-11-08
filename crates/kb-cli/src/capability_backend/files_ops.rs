//! 文件操作:移动、删除、回收站、格式转换。

use crate::capability_backend::*;

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn restore_file_version_impl(
        &self,
        args: RestoreVersionArgs,
    ) -> Result<Value> {
        // 笔记的版本和文件的版本存在同一张表里:先看这条版本属于笔记还是文件
        if let Some(version) = self.file_edits().version(&args.version_id).await?
            && kb_core::ports::repo::InsightRepo::get(self.rt().meta.as_ref(), &version.item_id)
                .await?
                .is_some()
        {
            let result = self
                .items()
                .restore_insight_version(&args.version_id, &self.actor_label())
                .await?;
            self.publish_item_changed("edited", &result.id, &result.collection);
            self.tell_collab_of_external_write(self.insight_key(&result.id).await)
                .await;
            return Ok(json!({
                "id": result.id,
                "version": result.version,
                "collection": result.collection,
                "job_id": result.job_id,
            }));
        }
        if let Some(version) = self.file_edits().version(&args.version_id).await? {
            self.refuse_while_collaborating(kb_core::share::ResourceKey::file(
                &self.call_space_id(),
                &version.collection,
                &version.source,
            ))
            .await?;
        }
        let restored_key = match self.file_edits().version(&args.version_id).await? {
            Some(version) => kb_core::share::ResourceKey::file(
                &self.call_space_id(),
                &version.collection,
                &version.source,
            )
            .ok(),
            None => None,
        };
        let result = self.file_edits().restore(&args.version_id, "web").await?;
        self.tell_collab_of_external_write(restored_key).await;
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化恢复结果失败: {err}")))?)
    }

    pub(super) async fn file_actions_impl(&self, args: FileActionsArgs) -> Result<Value> {
        let mut actions = self
            .file_ops()
            .actions(&args.collection, &args.path)
            .await?;
        // 菜单是只读查询,分享链接也能打开;但链接权限再高也不能删 / 移,
        // 删除能力本身也不在链接白名单里,菜单必须和真实能力面一致。
        if self.call_via_link() {
            actions.delete = kb_core::model::FileActionAvailability::no("通过分享链接不能删除");
            actions.r#move = kb_core::model::FileActionAvailability::no("通过分享链接不能移动");
        } else if let (Some(system), Some(principal)) =
            (&self.system, kb_capability::current_principal())
            && !principal.local
        {
            // 别人的知识库里,删除要 Manager,移动只服务于所有者自己的空间(共享闸门不开放移动)。
            let key = if actions.folder {
                kb_core::share::ResourceKey::dir(
                    &self.call_space_id(),
                    &args.collection,
                    &args.path,
                )
            } else {
                kb_core::share::ResourceKey::file(
                    &self.call_space_id(),
                    &args.collection,
                    &args.path,
                )
            }?;
            let role = system
                .role_of(
                    &principal.user_id,
                    &key,
                    kb_service::llm_gate::today_now_millis(),
                )
                .await?;
            match role {
                Some(role) => {
                    if !role.allows(kb_core::share::Action::Delete) {
                        let reason = format!("你的权限是「{}」,不能删除", role.label());
                        actions.delete = kb_core::model::FileActionAvailability::no(reason);
                    }
                    if role != kb_core::share::Role::Owner {
                        actions.r#move = kb_core::model::FileActionAvailability::no(
                            "移动只能在自己知识库里操作",
                        );
                    }
                }
                None => {
                    // 闸门已经挡过一轮;这里再兜底,绝不把可操作菜单给一个查不到角色的人
                    actions.delete = kb_core::model::FileActionAvailability::no("没有找到这个文件");
                    actions.r#move = kb_core::model::FileActionAvailability::no("没有找到这个文件");
                }
            }
        }
        Ok(serde_json::to_value(actions)
            .map_err(|err| KbError::Internal(format!("序列化文件菜单失败: {err}")))?)
    }

    pub(super) async fn delete_file_impl(&self, args: DeleteFileArgs) -> Result<Value> {
        self.guard_file_mutation(&args.collection, &args.path, false)
            .await?;
        let op = self
            .file_ops()
            .delete_file(&args.collection, &args.path, &args.fingerprint)
            .await?;
        // 删除即撤分享:分享链接与游客不能继续访问一个已经不存在的文件。
        // 恢复时不自动恢复分享。
        self.forget_shares(kb_core::share::ResourceKey::file(
            &self.call_space_id(),
            &args.collection,
            &args.path,
        ))
        .await;
        self.publish_item_changed("deleted", &args.path, &args.collection);
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化删除结果失败: {err}")))?)
    }

    pub(super) async fn delete_folder_impl(&self, args: DeleteFolderArgs) -> Result<Value> {
        self.guard_file_mutation(&args.collection, &args.path, true)
            .await?;
        let op = self
            .file_ops()
            .delete_folder(&args.collection, &args.path, &args.fingerprint)
            .await?;
        // 全部失败时文件还在:不能撤分享,也不能让界面以为文件夹没了。
        // 部分成功仍然撤掉整个文件夹的分享——用户点的是删除,残留的链接不应该继续可用;
        // 没删掉的文件由用户重新分享。
        if op.state != kb_core::model::FileOpState::Failed {
            self.forget_shares(kb_core::share::ResourceKey::dir(
                &self.call_space_id(),
                &args.collection,
                &args.path,
            ))
            .await;
            self.publish_item_changed("deleted", &args.path, &args.collection);
        }
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化删除结果失败: {err}")))?)
    }

    pub(super) async fn move_file_impl(&self, args: MoveFileArgs) -> Result<Value> {
        self.guard_file_mutation(&args.collection, &args.path, false)
            .await?;
        let target_collection =
            Self::target_collection(&args.collection, args.target_collection.as_deref());
        let name = args
            .new_name
            .as_deref()
            .unwrap_or_else(|| args.path.rsplit('/').next().unwrap_or(&args.path));
        let to = Self::joined_target(&args.target_dir, name);
        let cross = target_collection != args.collection;
        if cross {
            self.guard_file_mutation(target_collection, &to, false)
                .await?;
        }
        let op = self
            .file_ops()
            .move_file(
                &args.collection,
                &args.path,
                target_collection,
                &args.target_dir,
                args.new_name.as_deref(),
                &args.fingerprint,
            )
            .await?;
        if cross {
            // 跨库后旧库的授权 / 链接不能继续指向一个已经不在那儿的路径;
            // 新路径不自动带分享(删除即撤分享同理)。
            self.forget_shares(kb_core::share::ResourceKey::file(
                &self.call_space_id(),
                &args.collection,
                &args.path,
            ))
            .await;
            self.publish_item_changed("deleted", &args.path, &args.collection);
            self.publish_item_changed("moved", &to, target_collection);
        } else {
            self.rekey_file_shares(&args.collection, &args.path, &to, false)
                .await;
            self.publish_item_changed("moved", &to, &args.collection);
        }
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化移动结果失败: {err}")))?)
    }

    pub(super) async fn move_files_impl(&self, args: MoveFilesArgs) -> Result<Value> {
        let target_collection =
            Self::target_collection(&args.collection, args.target_collection.as_deref());
        let cross = target_collection != args.collection;
        let mut items = Vec::with_capacity(args.items.len());
        for item in &args.items {
            self.guard_file_mutation(&args.collection, &item.path, false)
                .await?;
            if cross {
                let name = item.path.rsplit('/').next().unwrap_or(&item.path);
                let to = Self::joined_target(&args.target_dir, name);
                self.guard_file_mutation(target_collection, &to, false)
                    .await?;
            }
            items.push((item.path.clone(), item.fingerprint.clone()));
        }
        let op = self
            .file_ops()
            .move_files(
                &args.collection,
                &items,
                target_collection,
                &args.target_dir,
            )
            .await?;
        for item in &args.items {
            let name = item.path.rsplit('/').next().unwrap_or(&item.path);
            let to = Self::joined_target(&args.target_dir, name);
            if cross {
                self.forget_shares(kb_core::share::ResourceKey::file(
                    &self.call_space_id(),
                    &args.collection,
                    &item.path,
                ))
                .await;
                self.publish_item_changed("deleted", &item.path, &args.collection);
                self.publish_item_changed("moved", &to, target_collection);
            } else {
                self.rekey_file_shares(&args.collection, &item.path, &to, false)
                    .await;
                self.publish_item_changed("moved", &to, &args.collection);
            }
        }
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化移动结果失败: {err}")))?)
    }

    pub(super) async fn move_folder_impl(&self, args: MoveFolderArgs) -> Result<Value> {
        self.guard_file_mutation(&args.collection, &args.path, true)
            .await?;
        let target_collection =
            Self::target_collection(&args.collection, args.target_collection.as_deref());
        let name = args
            .new_name
            .as_deref()
            .unwrap_or_else(|| args.path.rsplit('/').next().unwrap_or(&args.path));
        let to = Self::joined_target(&args.target_dir, name);
        let cross = target_collection != args.collection;
        if cross {
            self.guard_file_mutation(target_collection, &to, true)
                .await?;
        }
        let op = self
            .file_ops()
            .move_folder(
                &args.collection,
                &args.path,
                target_collection,
                &args.target_dir,
                args.new_name.as_deref(),
                &args.fingerprint,
            )
            .await?;
        if cross {
            self.forget_shares(kb_core::share::ResourceKey::dir(
                &self.call_space_id(),
                &args.collection,
                &args.path,
            ))
            .await;
            self.publish_item_changed("deleted", &args.path, &args.collection);
            self.publish_item_changed("moved", &to, target_collection);
        } else {
            self.rekey_file_shares(&args.collection, &args.path, &to, true)
                .await;
            self.publish_item_changed("moved", &to, &args.collection);
        }
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化移动结果失败: {err}")))?)
    }

    pub(super) async fn file_op_status_impl(&self, args: FileOpIdArgs) -> Result<Value> {
        let op = self.file_ops().op(&args.op_id).await?;
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化操作状态失败: {err}")))?)
    }

    pub(super) async fn list_trash_impl(&self, args: ListTrashArgs) -> Result<Value> {
        let page = kb_core::model::Page::new(
            args.limit.unwrap_or(50).clamp(1, 500),
            args.offset.unwrap_or(0),
        );
        let entries = self
            .file_ops()
            .list_trash(args.collection.as_deref(), page)
            .await?;
        let total = self
            .file_ops()
            .count_trash(args.collection.as_deref())
            .await?;
        Ok(json!({ "entries": entries, "total": total }))
    }

    pub(super) async fn restore_trash_impl(&self, args: TrashIdArgs) -> Result<Value> {
        let entry =
            kb_core::ports::repo::FileOpsRepo::get_trash(self.rt().meta.as_ref(), &args.trash_id)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("回收站条目 {}", args.trash_id)))?;
        let op = self.file_ops().restore(&args.trash_id).await?;
        // 其他客户端也要知道这个路径重新有文件了(分享不自动恢复,但列表 / 树要刷新)。
        self.publish_item_changed("restored", &entry.original_path, &entry.collection);
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化恢复结果失败: {err}")))?)
    }

    pub(super) async fn purge_trash_impl(&self, args: TrashIdArgs) -> Result<Value> {
        // 彻底删除前先拿到原路径,才能把它的授权 / 分享链接一起清掉。
        let entry =
            kb_core::ports::repo::FileOpsRepo::get_trash(self.rt().meta.as_ref(), &args.trash_id)
                .await?;
        let op = self.file_ops().purge(&args.trash_id).await?;
        if let Some(entry) = entry {
            self.forget_shares(kb_core::share::ResourceKey::file(
                &self.call_space_id(),
                &entry.collection,
                &entry.original_path,
            ))
            .await;
            self.publish_item_changed("deleted", &entry.original_path, &entry.collection);
        }
        Ok(serde_json::to_value(op)
            .map_err(|err| KbError::Internal(format!("序列化彻底删除结果失败: {err}")))?)
    }

    pub(super) async fn convert_to_markdown_impl(
        &self,
        args: ConvertMarkdownArgs,
    ) -> Result<Value> {
        let result = self
            .markdown_copies()
            .convert(&args.collection, &args.path, "web")
            .await?;
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化副本结果失败: {err}")))?)
    }
}
