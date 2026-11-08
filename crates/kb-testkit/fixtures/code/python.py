"""示例 Python 模块,用于分块测试。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Iterable


@dataclass
class Config:
    """服务配置。"""

    name: str
    port: int = 7878
    retries: int = 3
    tags: list[str] = field(default_factory=list)

    def describe(self) -> str:
        """返回 name:port。"""
        return f"{self.name}:{self.port}"

    def with_tag(self, tag: str) -> "Config":
        """追加标签并返回自身。"""
        self.tags.append(tag)
        return self


class Service:
    """一个简单的服务。"""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.running = False
        self.counters: dict[str, int] = {}

    def start(self) -> bool:
        """启动服务。"""
        self.running = True
        return self.running

    def stop(self) -> bool:
        """停止服务。"""
        self.running = False
        return self.running

    def record(self, key: str) -> None:
        """记录一次调用。"""
        self.counters[key] = self.counters.get(key, 0) + 1

    def count(self, key: str) -> int:
        """取计数。"""
        return self.counters.get(key, 0)


def fibonacci(n: int) -> int:
    """计算斐波那契数列。"""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


def parse_port(value: str) -> int | None:
    """解析端口。"""
    try:
        return int(value.strip())
    except ValueError:
        return None


def total(values: Iterable[int]) -> int:
    """求和。"""
    result = 0
    for value in values:
        result += value
    return result


def load_config(path: str) -> Config:
    """从文件加载配置。"""
    name = os.path.basename(path)
    return Config(name=name, port=7878)


@staticmethod
def _unused() -> None:
    """一个静态方法,用于测试装饰器节点。"""


def run(config: Config) -> int:
    """入口函数。"""
    service = Service(config)
    service.start()
    service.record("run")
    value = fibonacci(10) + total([1, 2, 3])
    service.stop()
    return value


if __name__ == "__main__":
    print(run(load_config("demo.toml")))


def retry(times: int):
    """一个简单的重试装饰器。"""

    def wrapper(func):
        def inner(*args, **kwargs):
            last = None
            for _ in range(times):
                try:
                    return func(*args, **kwargs)
                except Exception as error:  # noqa: BLE001
                    last = error
            raise last

        return inner

    return wrapper


@retry(3)
def flaky(value: int) -> int:
    """可能失败的函数。"""
    if value < 0:
        raise ValueError("negative")
    return value * 2
