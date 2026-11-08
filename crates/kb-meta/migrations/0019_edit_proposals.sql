-- AI(经 MCP)对文档的修改建议:默认 AI 只能提建议,由人在页面上接受才生效。
-- 一条建议 = 对一篇笔记或一个文件的几处「把这段文字换成那段」;接受时按当时的内容重新定位,定位不到就标成失败。
CREATE TABLE IF NOT EXISTS edit_proposals (
    id          TEXT PRIMARY KEY,
    collection  TEXT NOT NULL,
    target      TEXT NOT NULL,              -- file:<相对路径> | note:<笔记 id>
    author      TEXT NOT NULL,              -- 提建议的(mcp:<客户端> / agent:… )
    note        TEXT NOT NULL DEFAULT '',   -- 一句话说明为什么这样改
    edits       TEXT NOT NULL,              -- JSON:[{"old": …, "new": …}]
    status      TEXT NOT NULL,              -- pending | accepted | rejected | failed
    result      TEXT,                       -- 失败的原因
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    decided_by  TEXT
);
CREATE INDEX IF NOT EXISTS edit_proposals_by_target ON edit_proposals(collection, target, status);
