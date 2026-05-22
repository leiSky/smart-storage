# Hook README

`src/hook/` 提供的是这套存储协议的响应式消费层，依赖 `@vue/reactivity`，不依赖完整 Vue 运行时。

实现设计说明见：

- [DESIGN.md](./DESIGN.md)

这一层解决 3 件事：

- 把异步存储包装成可直接消费的响应式状态
- 让同一个 `storage + key` 在同页内共享一份 `state`
- 让 `set / remove / refresh` 和 watcher 自动持久化走同一套顺序控制

## 导出

子入口：

```ts
import { useReactiveStorage } from 'smart-storage/hook';
import type {
  ReactiveStorageLike,
  UseReactiveStorageOptions,
  UseReactiveStorageReturn,
} from 'smart-storage/hook';
```

根入口额外提供两个默认 hook：

```ts
import {
  useLocalStorage,
  useSessionStorage,
} from 'smart-storage';
```

## 最小存储协议

`useReactiveStorage` 不绑定具体实现，只依赖最小协议：

```ts
type ReactiveStorageLike = {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<unknown>;
  remove(key: string): Promise<boolean | void>;
};
```

这意味着你可以传：

- `LocalSmartStorage`
- `SessionSmartStorage`
- 任何你自己的异步存储实现

## useReactiveStorage

```ts
import { useReactiveStorage } from 'smart-storage/hook';
import { LocalSmartStorage } from 'smart-storage';

const storage = new LocalSmartStorage({
  dbName: 'MyApp',
});

const {
  state,
  isReady,
  error,
  set,
  remove,
  refresh,
  dispose,
} = useReactiveStorage({
  key: 'profile',
  storage,
  initialValue: () => ({
    name: '',
    age: 0,
  }),
});
```

返回值说明：

- `state`：主响应式状态
- `isReady`：首次初始化读取是否结束
- `error`：最近一次读写错误
- `set(value)`：命令式整值更新
- `remove()`：删除持久化值并回退默认值
- `refresh()`：重新从存储读取并覆盖当前状态
- `dispose()`：释放当前 hook 对共享条目的消费者引用

## 默认 hook

### useLocalStorage

```ts
import { useLocalStorage } from 'smart-storage';

const { state, isReady } = useLocalStorage({
  key: 'profile',
  initialValue: () => ({
    name: '',
  }),
});
```

### useSessionStorage

```ts
import { useSessionStorage } from 'smart-storage';

const { state, refresh } = useSessionStorage({
  key: 'draft',
  initialValue: () => ({
    title: '',
  }),
});
```

这两个默认 hook 内部会使用各自的默认存储实例：

- `useLocalStorage` -> `LocalSmartStorage`
- `useSessionStorage` -> `SessionSmartStorage`

## 共享与顺序语义

### 同页共享

同一个 `storage + key` 只会维护一份共享条目，所以：

- 多个 hook 会复用同一份 `state`
- 任一处修改，其他消费者会立刻响应

### 自动持久化

直接修改 `state.value` 时：

- 共享 watcher 会感知变化
- 自动安排一次持久化
- 同一轮同步改动会先做 microtask 合并

### 命令式操作顺序

`set / remove / refresh` 会进入同一个串行队列：

- 避免 `set` 和 `remove` 互相抢跑
- 避免 `refresh` 在前一个写入完成前读到旧值

### remove 的特殊处理

`remove()` 在真正入队前，会先撤销尚未开始执行的自动同步意图。这样可以避免：

1. watcher 已经标记了一次待写入
2. 随后立刻调用 `remove()`
3. 旧的自动写入又把删除结果覆盖掉

## 生命周期

如果在活跃的响应式 scope 中使用：

- hook 会在 scope dispose 时自动释放消费者引用

如果不在 scope 中使用：

- 需要手动调用 `dispose()`

`dispose()` 的语义是“释放当前消费者”，不是强制销毁整个共享条目。只有最后一个消费者离开时，共享 watcher 和 registry 条目才会被回收。

## 使用建议

- 通常在 `isReady.value === true` 后，再执行依赖持久化状态的业务逻辑
- `refresh()` 会用存储值覆盖当前内存状态，不做合并
- `remove()` 会删除持久化值，并把 `state` 回退到默认值
- 默认值不会因为初始化读取未命中而被自动写回存储
