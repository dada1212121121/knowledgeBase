// 示例 C++ 模块,用于分块测试。
#include <iostream>
#include <map>
#include <string>
#include <vector>

namespace demo {

// 服务配置。
class Config {
public:
    Config(std::string name, int port) : name_(std::move(name)), port_(port) {}

    std::string describe() const { return name_ + ":" + std::to_string(port_); }

    int port() const { return port_; }

private:
    std::string name_;
    int port_;
};

// 服务状态。
enum class Status { Idle, Running, Stopped };

// 一个简单的服务。
class Service {
public:
    explicit Service(Config config) : config_(std::move(config)) {}

    Status start() {
        status_ = Status::Running;
        return status_;
    }

    Status stop() {
        status_ = Status::Stopped;
        return status_;
    }

    bool is_running() const { return status_ == Status::Running; }

    void record(const std::string &key) { counters_[key] += 1; }

    int count(const std::string &key) const {
        auto found = counters_.find(key);
        return found == counters_.end() ? 0 : found->second;
    }

    std::string describe() const { return config_.describe(); }

private:
    Config config_;
    Status status_ = Status::Idle;
    std::map<std::string, int> counters_;
};

// 计算斐波那契数列。
long fibonacci(int n) {
    long a = 0;
    long b = 1;
    for (int i = 0; i < n; ++i) {
        long next = a + b;
        a = b;
        b = next;
    }
    return a;
}

// 解析端口。
bool parse_port(const std::string &value, int &out) {
    try {
        size_t used = 0;
        int port = std::stoi(value, &used);
        if (used != value.size() || port < 0 || port > 65535) {
            return false;
        }
        out = port;
        return true;
    } catch (const std::exception &) {
        return false;
    }
}

// 求和。
int total(const std::vector<int> &values) {
    int sum = 0;
    for (int value : values) {
        sum += value;
    }
    return sum;
}

}  // namespace demo

// 入口函数。
int main() {
    demo::Config config("demo", 7878);
    demo::Service service(config);
    service.start();
    service.record("run");
    std::cout << service.describe() << "\n";
    std::cout << demo::fibonacci(10) + demo::total({1, 2, 3}) << "\n";
    service.stop();
    return 0;
}
