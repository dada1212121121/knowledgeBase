// 示例 Java 模块。
package demo;

public class Main {
    public static final class Config {
        private final String name;

        public Config(String name) {
            this.name = name;
        }

        public String describe() {
            return "config:" + name;
        }
    }

    public static int run(Config config) {
        return config.describe().length();
    }
}
