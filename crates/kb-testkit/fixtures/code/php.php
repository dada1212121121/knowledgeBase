<?php
// 简单的路由表(测试样本)

namespace App;

class Router
{
    private array $routes = [];

    // 注册一条路由
    public function add(string $method, string $path, callable $handler): void
    {
        $this->routes[$method][$path] = $handler;
    }

    // 分发请求
    public function dispatch(string $method, string $path)
    {
        $handler = $this->routes[$method][$path] ?? null;
        if ($handler === null) {
            http_response_code(404);
            return null;
        }
        return $handler();
    }
}

interface Middleware
{
    public function handle(callable $next);
}
