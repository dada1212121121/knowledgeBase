-- :网页来源的 AI 规范化。
-- ai_extract 默认 0:迁移前就有的数据源升级后不会突然开始调用模型、花 AI 额度,要用户自己打开。
ALTER TABLE sources ADD COLUMN ai_extract INTEGER NOT NULL DEFAULT 0;
-- 提取要求;空串 = 让模型自动判断页面类型、尽量全面地整理。
ALTER TABLE sources ADD COLUMN extract_prompt TEXT NOT NULL DEFAULT '';
-- 最近一次 AI 规范化的情况(已整理 / 待整理 / 失败页数与暂停原因,JSON);NULL = 没跑过。
ALTER TABLE sources ADD COLUMN ai_status_json TEXT;
