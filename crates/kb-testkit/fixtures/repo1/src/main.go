// Package main 是示例 Go 模块。
package main

import "fmt"

type Config struct {
	Name string
}

func (c Config) Describe() string {
	return fmt.Sprintf("config:%s", c.Name)
}

func Run(c Config) int {
	return len(c.Describe())
}
