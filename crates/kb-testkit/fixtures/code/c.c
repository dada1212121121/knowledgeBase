/* 示例 C 模块,用于分块测试。 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_NAME 64
#define DEFAULT_PORT 7878

/* 服务配置。 */
struct config {
    char name[MAX_NAME];
    int port;
    int retries;
};

/* 服务状态。 */
enum status {
    STATUS_IDLE = 0,
    STATUS_RUNNING = 1,
    STATUS_STOPPED = 2,
};

/* 计数器。 */
struct counter {
    char key[MAX_NAME];
    int value;
};

/* 新建配置。 */
struct config config_new(const char *name, int port) {
    struct config cfg;
    strncpy(cfg.name, name, MAX_NAME - 1);
    cfg.name[MAX_NAME - 1] = '\0';
    cfg.port = port;
    cfg.retries = 3;
    return cfg;
}

/* 描述配置。 */
void config_describe(const struct config *cfg, char *out, size_t size) {
    snprintf(out, size, "%s:%d", cfg->name, cfg->port);
}

/* 计算斐波那契数列。 */
long fibonacci(int n) {
    long a = 0;
    long b = 1;
    int i;
    for (i = 0; i < n; i++) {
        long next = a + b;
        a = b;
        b = next;
    }
    return a;
}

/* 解析端口。 */
int parse_port(const char *value, int *out) {
    char *end = NULL;
    long port;
    if (value == NULL || out == NULL) {
        return -1;
    }
    port = strtol(value, &end, 10);
    if (end == value || port < 0 || port > 65535) {
        return -1;
    }
    *out = (int)port;
    return 0;
}

/* 求和。 */
int total(const int *values, size_t count) {
    int sum = 0;
    size_t i;
    for (i = 0; i < count; i++) {
        sum += values[i];
    }
    return sum;
}

/* 记录一次调用。 */
static void counter_record(struct counter *counters, size_t capacity, const char *key) {
    size_t i;
    for (i = 0; i < capacity; i++) {
        if (counters[i].value == 0) {
            strncpy(counters[i].key, key, MAX_NAME - 1);
            counters[i].key[MAX_NAME - 1] = '\0';
            counters[i].value = 1;
            return;
        }
        if (strcmp(counters[i].key, key) == 0) {
            counters[i].value++;
            return;
        }
    }
}

/* 入口函数。 */
int main(void) {
    struct config cfg = config_new("demo", DEFAULT_PORT);
    struct counter counters[8];
    char description[128];
    int values[] = {1, 2, 3};

    memset(counters, 0, sizeof(counters));
    config_describe(&cfg, description, sizeof(description));
    printf("%s\n", description);
    counter_record(counters, 8, "run");
    printf("%ld\n", fibonacci(10) + total(values, 3));
    return 0;
}
