// 示例 Java 模块,用于分块测试。
package demo;

import java.util.HashMap;
import java.util.Map;

/** 服务配置。 */
public class Main {
    /** 配置。 */
    public static final class Config {
        private final String name;
        private final int port;
        private final int retries;

        public Config(String name, int port) {
            this.name = name;
            this.port = port;
            this.retries = 3;
        }

        public String describe() {
            return name + ":" + port;
        }

        public int retries() {
            return retries;
        }
    }

    /** 服务状态。 */
    public enum Status {
        IDLE,
        RUNNING,
        STOPPED,
    }

    /** 可以启动的东西。 */
    public interface Startable {
        Status start();

        Status stop();

        boolean isRunning();
    }

    /** 一个简单的服务。 */
    public static class Service implements Startable {
        private final Config config;
        private Status status = Status.IDLE;
        private final Map<String, Integer> counters = new HashMap<>();

        public Service(Config config) {
            this.config = config;
        }

        @Override
        public Status start() {
            status = Status.RUNNING;
            return status;
        }

        @Override
        public Status stop() {
            status = Status.STOPPED;
            return status;
        }

        @Override
        public boolean isRunning() {
            return status == Status.RUNNING;
        }

        public void record(String key) {
            counters.merge(key, 1, Integer::sum);
        }

        public int count(String key) {
            return counters.getOrDefault(key, 0);
        }

        public String describe() {
            return config.describe();
        }
    }

    /** 计算斐波那契数列。 */
    public static long fibonacci(int n) {
        long a = 0;
        long b = 1;
        for (int i = 0; i < n; i++) {
            long next = a + b;
            a = b;
            b = next;
        }
        return a;
    }

    /** 解析端口。 */
    public static Integer parsePort(String value) {
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException error) {
            return null;
        }
    }

    /** 入口函数。 */
    public static long run(Config config) {
        Service service = new Service(config);
        service.start();
        service.record("run");
        long value = fibonacci(10) + service.count("run");
        service.stop();
        return value;
    }
}
