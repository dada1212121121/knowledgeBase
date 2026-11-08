"""示例 Python 模块。"""

import os


class Config:
    """配置对象。"""

    def __init__(self, name: str) -> None:
        self.name = name

    def describe(self) -> str:
        return f"config:{self.name}"


def run(config: Config) -> int:
    """入口函数。"""
    return len(os.listdir(".")) + len(config.name)
