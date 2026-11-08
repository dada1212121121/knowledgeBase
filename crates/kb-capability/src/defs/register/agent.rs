//! 伴生与 ACP:会话、权限、上下文估算,以及写入类动作的确认。

use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AgentSendArgs| {
            let backend = backend.clone();
            async move { backend.agent_send(args).await }
        })
    };
    registry.register(Capability {
        name: "agent_send",
        description: "AI 管家:发一句话,模型最多调 8 次工具;有副作用的操作返回计划卡片等确认",
        permission: Permission::Write,
        surfaces: AGENT_ONLY,
        side_effect: true,
        input_schema: schema::<AgentSendArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AiWriteArgs| {
            let backend = backend.clone();
            async move { backend.ai_write(args).await }
        })
    };
    // 只给网页编辑器用:结果交回页面、由人确认后才写进文档;不进 MCP / 代理面(那边有自己的写入流程)。
    // side_effect = true:花的是付费人的 AI 额度
    registry.register(Capability {
 name: "ai_write",
 description: "编辑器里的 AI 写作:润色 / 总结 / 翻译 / 续写 / 按要求改写选中的文字;无状态,不改任何数据",
 permission: Permission::Read,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<AiWriteArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AgentConfirmArgs| {
                let backend = backend.clone();
                async move { backend.agent_confirm(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "agent_confirm",
        description: "AI 管家:确认一张计划卡片并执行(校验参数哈希,执行开批次可撤销)",
        permission: Permission::Write,
        surfaces: AGENT_ONLY,
        side_effect: true,
        input_schema: schema::<AgentConfirmArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.acp_agents().await }
        })
    };
    registry.register(Capability {
        name: "acp_agents",
        description: "ACP 接入:可用的外部代理(内置 + 自定义)与权限策略",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let _backend = backend.clone();
            async move { Ok(serde_json::json!({ "commands": CHAT_COMMANDS })) }
        })
    };
    registry.register(Capability {
        name: "chat_commands",
        description: "聊天框里允许使用的 @ 快捷命令(白名单)",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AcpSaveAgentArgs| {
                let backend = backend.clone();
                async move { backend.acp_save_agent(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "acp_save_agent",
        description: "ACP 接入:新增 / 修改自定义代理(command / args / env)",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpSaveAgentArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpAgentIdArgs| {
            let backend = backend.clone();
            async move { backend.acp_remove_agent(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_remove_agent",
        description: "ACP 接入:删除自定义代理",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpAgentIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AcpPermissionArgs| {
                let backend = backend.clone();
                async move { backend.acp_set_permission(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "acp_set_permission",
        description: "ACP 接入:设置代理请求工具权限时的自动答复策略(none / read / all)",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpPermissionArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpAgentIdArgs| {
            let backend = backend.clone();
            async move { backend.acp_install(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_install",
        description: "ACP 接入:用 npm 安装代理(内置目录里带 npm 包的那些)",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpAgentIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpAgentIdArgs| {
            let backend = backend.clone();
            async move { backend.acp_uninstall(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_uninstall",
        description: "ACP 接入:用 npm 卸载代理",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpAgentIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpDefaultArgs| {
            let backend = backend.clone();
            async move { backend.acp_set_default(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_set_default",
        description: "ACP 接入:设置默认后端(空串 = 内置模型)",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpDefaultArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpSandboxArgs| {
            let backend = backend.clone();
            async move { backend.acp_set_sandbox(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_set_sandbox",
        description: "ACP 接入:是否用 bwrap 把代理关进沙箱(默认开)",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpSandboxArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AcpPermissionDecisionArgs| {
                let backend = backend.clone();
                async move { backend.acp_permission(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "acp_permission",
        description: "ACP 接入:答复代理的权限请求(允许 / 拒绝)",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpPermissionDecisionArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpAgentIdArgs| {
            let backend = backend.clone();
            async move { backend.acp_test(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_test",
        description: "ACP 接入:拉起代理做一次 initialize,返回代理名 / 版本",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpAgentIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpChatArgs| {
            let backend = backend.clone();
            async move { backend.acp_chat(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_chat",
        description: "ACP 接入:把一句话交给外部代理(流式增量走 WS acp.update)",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpChatArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AcpCancelArgs| {
            let backend = backend.clone();
            async move { backend.acp_cancel(args).await }
        })
    };
    registry.register(Capability {
        name: "acp_cancel",
        description: "ACP 接入:取消当前轮次",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<AcpCancelArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ContextEstimateArgs| {
                let backend = backend.clone();
                async move { backend.context_estimate(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "context_estimate",
        description: "上下文增强:估算把 collection 切到 LLM 模式要花多少 token",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<ContextEstimateArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ApplyContextArgs| {
                let backend = backend.clone();
                async move { backend.apply_context(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "apply_context",
        description: "上下文增强:切换 collection 的 context_mode 并投递重嵌入(dry_run 默认 true)",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<ApplyContextArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: AgentHistoryArgs| {
            let backend = backend.clone();
            async move { backend.agent_history(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "agent_history",
        description: "AI 管家:会话记录(读某次对话的消息,给 @会话 引用用)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<AgentHistoryArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AgentSessionsArgs| {
                let backend = backend.clone();
                async move { backend.agent_sessions(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "agent_sessions",
        description: "AI 管家:最近的会话列表(标题 / 时间 / 条数)",
        permission: Permission::Read,
        surfaces: AGENT_ONLY,
        side_effect: false,
        input_schema: schema::<AgentSessionsArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AgentDeleteSessionArgs| {
                let backend = backend.clone();
                async move { backend.agent_delete_session(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "agent_delete_session",
        description: "AI 管家:删除一个会话的全部消息",
        permission: Permission::Write,
        surfaces: AGENT_ONLY,
        side_effect: true,
        input_schema: schema::<AgentDeleteSessionArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AgentCompressArgs| {
                let backend = backend.clone();
                async move { backend.agent_compress(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "agent_compress",
        description: "AI 管家:把较早的对话压缩成摘要(上下文管理)",
        permission: Permission::Write,
        surfaces: AGENT_ONLY,
        side_effect: true,
        input_schema: schema::<AgentCompressArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AgentRenameSessionArgs| {
                let backend = backend.clone();
                async move { backend.agent_rename_session(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "agent_rename_session",
        description: "AI 管家:重命名会话(空标题 = 恢复成首条用户消息)",
        permission: Permission::Write,
        surfaces: AGENT_ONLY,
        side_effect: true,
        input_schema: schema::<AgentRenameSessionArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AgentPinSessionArgs| {
                let backend = backend.clone();
                async move { backend.agent_pin_session(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "agent_pin_session",
        description: "AI 管家:置顶 / 取消置顶会话",
        permission: Permission::Write,
        surfaces: AGENT_ONLY,
        side_effect: true,
        input_schema: schema::<AgentPinSessionArgs>(),
        handler,
    });
}
