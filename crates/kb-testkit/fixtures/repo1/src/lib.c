/* 示例 C 模块。 */
#include <stdio.h>
#include <string.h>

struct config {
    const char *name;
};

int run(const struct config *cfg) {
    return (int)strlen(cfg->name);
}

int main(void) {
    struct config cfg = {"demo"};
    printf("%d\n", run(&cfg));
    return 0;
}
