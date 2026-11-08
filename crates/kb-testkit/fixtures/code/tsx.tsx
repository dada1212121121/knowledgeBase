// 示例 TSX 模块,用于分块测试。
import { useEffect, useState } from "react";

export interface CounterProps {
  initial?: number;
  step?: number;
  label: string;
}

export function Counter({ initial = 0, step = 1, label }: CounterProps) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    document.title = `${label}: ${value}`;
  }, [label, value]);

  return (
    <div className="counter">
      <span>{label}</span>
      <button type="button" onClick={() => setValue((current) => current - step)}>
        -
      </button>
      <strong>{value}</strong>
      <button type="button" onClick={() => setValue((current) => current + step)}>
        +
      </button>
    </div>
  );
}

interface ListProps<T> {
  items: T[];
  render: (item: T) => string;
}

export function List<T>({ items, render }: ListProps<T>) {
  if (items.length === 0) {
    return <p>没有内容</p>;
  }
  return (
    <ul>
      {items.map((item, index) => (
        <li key={index}>{render(item)}</li>
      ))}
    </ul>
  );
}

export const Badge = ({ text }: { text: string }) => (
  <span className="badge" title={text}>
    {text}
  </span>
);

export default Counter;
