-- 审核收件箱的乐观锁:抢占标记。
-- 「通过」是先建 insight 再回写草稿的,没有事务;用 claimed_at 做互斥,
-- 两个标签页同时点「通过」时只有一个能抢到,不会各建一条 insight。
ALTER TABLE drafts ADD COLUMN claimed_at INTEGER;
