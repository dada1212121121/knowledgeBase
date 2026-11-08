// 一个简单的计数器(测试样本)
import Foundation

protocol Resettable {
    func reset()
}

struct Counter: Resettable {
    private(set) var value: Int = 0

    // 加一
    mutating func increment() {
        value += 1
    }

    func reset() {
        self = Counter()
    }
}

enum Direction {
    case up
    case down
}

extension Counter {
    func describe() -> String {
        return "counter=\(value)"
    }
}
