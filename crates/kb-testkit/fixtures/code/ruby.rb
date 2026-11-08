# 简单的任务队列(测试样本)
require 'json'

module Queue
  # 一个内存队列
  class Memory
    def initialize
      @items = []
    end

    # 入队
    def push(item)
      @items << item
      self
    end

    # 出队
    def pop
      @items.shift
    end

    def size
      @items.size
    end
  end

  # 处理一批任务
  def self.drain(queue, &block)
    while (item = queue.pop)
      block.call(item)
    end
  end
end
