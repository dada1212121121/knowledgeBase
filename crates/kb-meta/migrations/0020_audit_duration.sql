-- 审计表补「耗时」与「降级原因」。
-- 此前 ResponseMeta.took_ms 算出来了却没入库,线上回答不了「昨天最慢的 10 条查询」
-- 「降级率多少」;只能靠外部 curl 计时。旧行的这两列是 NULL,读出来按「未记录」处理。
ALTER TABLE audit ADD COLUMN took_ms INTEGER;
ALTER TABLE audit ADD COLUMN degraded TEXT;
