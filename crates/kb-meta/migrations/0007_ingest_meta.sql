-- 解析队列的「内容」列:从抽取出来的锚点统计页数 / 表数 / 幻灯片 / 时长,以及是否需要 OCR。
-- 只加一列(JSON 文本),旧行保持 NULL,前端拿不到就退回显示块数 / 文件大小。
ALTER TABLE ingest_files ADD COLUMN extract_meta TEXT;
