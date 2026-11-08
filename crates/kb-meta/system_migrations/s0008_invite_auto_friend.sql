-- 邀请码可以设成「用它注册的人自动和邀请人互为好友」(多用户设计说明)。
-- 默认开:拿邀请码把人拉进来,通常就是认识的人。
ALTER TABLE invite_codes ADD COLUMN auto_friend INTEGER NOT NULL DEFAULT 1;
