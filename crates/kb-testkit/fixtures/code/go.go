// 示例 Go 模块,用于分块测试。
package demo

import (
	"fmt"
	"strconv"
	"strings"
)

// Config 是服务配置。
type Config struct {
	Name    string
	Port    int
	Retries int
}

// Status 是服务状态。
type Status int

const (
	// Idle 表示未启动。
	Idle Status = iota
	// Running 表示运行中。
	Running
	// Stopped 表示已停止。
	Stopped
)

// Startable 可以启动。
type Startable interface {
	Start() Status
	Stop() Status
	IsRunning() bool
}

// NewConfig 构造配置。
func NewConfig(name string, port int) Config {
	return Config{Name: name, Port: port, Retries: 3}
}

// Describe 返回 name:port。
func (c Config) Describe() string {
	return fmt.Sprintf("%s:%d", c.Name, c.Port)
}

// Service 是一个简单的服务。
type Service struct {
	config   Config
	status   Status
	counters map[string]int
}

// NewService 新建服务。
func NewService(config Config) *Service {
	return &Service{
		config:   config,
		status:   Idle,
		counters: map[string]int{},
	}
}

// Start 启动服务。
func (s *Service) Start() Status {
	s.status = Running
	return s.status
}

// Stop 停止服务。
func (s *Service) Stop() Status {
	s.status = Stopped
	return s.status
}

// IsRunning 是否运行中。
func (s *Service) IsRunning() bool {
	return s.status == Running
}

// Record 记录一次调用。
func (s *Service) Record(key string) {
	s.counters[key]++
}

// Count 取计数。
func (s *Service) Count(key string) int {
	return s.counters[key]
}

// Fibonacci 计算斐波那契数列。
func Fibonacci(n int) int {
	a, b := 0, 1
	for i := 0; i < n; i++ {
		a, b = b, a+b
	}
	return a
}

// ParsePort 解析端口。
func ParsePort(value string) (int, error) {
	return strconv.Atoi(strings.TrimSpace(value))
}

// Total 求和。
func Total(values []int) int {
	sum := 0
	for _, value := range values {
		sum += value
	}
	return sum
}

// Run 入口函数。
func Run(config Config) int {
	service := NewService(config)
	service.Start()
	service.Record("run")
	value := Fibonacci(10) + Total([]int{1, 2, 3})
	service.Stop()
	return value
}
