-- 收尾的补充:把历史遗留的“human 模式落成 approved 但没有 insight_id”的草稿放回收件箱。
-- 旧实现在 review_mode != 'ai' 时也把草稿写成 approved,这些行既不在收件箱(按 pending 过滤),
-- 也没有转正(insight_id 为空),等于永久卡住。这里只改这一类行。
UPDATE drafts SET state = 'pending', decided_at = NULL
 WHERE state IN ('approved', 'revised') AND insight_id IS NULL;
