-- 资源采样(卡 D):守护进程每 10 秒采一次本机 CPU / 内存 / 负载 / 磁盘和本服务进程的占用,
-- 每分钟聚合成一行写在这里(平均值,CPU 另存最大值),保留 30 天(约 4.3 万行、几 MB)。
-- 只有管理员能读(能力 metrics_series);主键就是整分钟的起点(毫秒),重启后同一分钟再写会覆盖,不会重复。
CREATE TABLE IF NOT EXISTS metric_samples (
  at         INTEGER PRIMARY KEY,
  cpu        REAL    NOT NULL,
  cpu_max    REAL    NOT NULL,
  mem_used   INTEGER NOT NULL,
  mem_total  INTEGER NOT NULL,
  load1      REAL    NOT NULL,
  disk_used  INTEGER NOT NULL,
  disk_total INTEGER NOT NULL,
  proc_cpu   REAL    NOT NULL,
  proc_rss   INTEGER NOT NULL
);
