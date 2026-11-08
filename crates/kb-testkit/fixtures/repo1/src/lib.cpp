// 示例 C++ 模块。
#include <string>

namespace demo {

class Config {
public:
    explicit Config(std::string name) : name_(std::move(name)) {}

    std::string describe() const { return "config:" + name_; }

private:
    std::string name_;
};

int run(const Config &config) {
    return static_cast<int>(config.describe().size());
}

}  // namespace demo
