# Hook DESIGN

这份文档说明 `src/hook/` 这一层的实现目标、运行逻辑和关键边界。

它不是对外 API 速查，而是实现设计说明。

## 目标

`src/hook/` 不是新的存储实现，而是现有存储协议的响应式消费层。

这一层主要解决 4 件事：

1. 把异步存储包装成可直接消费的响应式状态
2. 让同一个 `storage + key` 在同页内共享一份 `state`
3. 让自动持久化与命令式操作共享一条顺序控制链
4. 在有 scope 和无 scope 两种使用方式下都能回收消费者引用

## 核心对象

### ReactiveStorageLike

最小存储协议，只要求：

- `get(key)`
- `set(key, value)`
- `remove(key)`

hook 层不关心底层是 `localStorage`、`sessionStorage`、`IndexedDB`，还是用户自定义实现。

### SharedReactiveStorageEntry

同一个 `storage + key` 对应一份共享条目。

共享条目里保存：

- 共享状态：`state / isReady / error`
- 自动同步调度状态
- 生命周期引用计数
- 一条串行队列 `storageQueue`

所有同 key 的 hook 拿到的，都是这同一份条目，而不是副本。

### registry

registry 用两级映射缓存共享条目：

```ts
WeakMap<storage, Map<key, entry>>
```

这意味着共享粒度严格是：

- 同一个 storage 实例
- 同一个 key

### SerialExecQueue

`SerialExecQueue` 只负责一件事：

**保证同一个共享条目的异步任务按提交顺序逐个执行。**

它不负责：

- 存储协议
- 错误状态
- 任务合并策略
- 业务语义

## 状态字段

### state

真正给业务消费的响应式状态本体。

### isReady

首次初始化读取是否结束。

它表示“初始化流程结束了”，不表示“当前值一定来自持久化层”。

### error

最近一次读写失败的错误。

成功操作后会清空。

### isHydrating

标记当前是不是“内部受控回填”。

典型场景：

- 初始化读取
- `refresh()`
- `set()` 整体替换
- `remove()` 后回退默认值

当它为 `true` 时，共享 watcher 不会再安排自动持久化。

### syncScheduled

当前是否已经安排过一轮自动同步的 microtask。

### syncInFlight

当前是否有一轮 watcher 触发的自动同步正在执行。

### mutationVersion

共享状态的逻辑变更版本号。

它用来判断：

- 当前自动同步开始后，期间有没有新变更发生
- 如果有，结束后是否还需要再补一轮同步

### hasPendingSync

当前是否存在尚未真正开始执行的自动同步请求。

这主要服务 watcher 自动持久化，不服务命令式 `set/remove/refresh`。

### initializePromise

首次初始化读取任务。

它只表示“第一次初始化”这件事，供多个消费者复用。

命令式 `refresh()` 不会覆写它。

### consumers

当前有多少 hook 正在消费这份共享条目。

### stopWatcher

共享 watcher 的释放句柄。

### resolveInitialValue

默认值工厂。

它用于：

- 首次创建共享状态
- 读取未命中时回退默认值
- `remove()` 后回退默认值

## 运行流程

### 1. 初始化

`useReactiveStorage()` 执行时：

1. 按 `storage + key` 从 registry 查共享条目
2. 如果没有，则新建条目
3. `retainEntry(entry)`，增加消费者计数
4. `ensureInitialized(entry)`，触发首次初始化读取

首次初始化读取的逻辑：

1. 打开 `isHydrating`
2. 读取存储值
3. 有值则覆盖 `state`
4. 无值则回退默认值
5. 关闭 `isHydrating`
6. `isReady = true`

初始化错误不会继续抛给调用方，但会写进 `error`。

### 2. 自动持久化

共享条目创建时，会为 `state` 建一份深度 watcher。

业务直接修改 `state.value` 时：

1. watcher 触发
2. 如果当前不是 `isHydrating`
3. 标记 `hasPendingSync = true`
4. `mutationVersion += 1`
5. 安排一个 microtask

microtask 会调用 `syncEntryToStorage()`：

1. 读取当前 `state`
2. 通过 `storageQueue` 串行写入存储
3. 如果写入期间 `mutationVersion` 继续增长
4. 结束后再补一轮自动同步

这里的自动持久化只会写 `set`，不会自动执行 `remove`。

### 3. set

`set(value)` 是命令式整值替换。

它会通过 `runQueuedStorageAction()` 进入共享队列，在队列任务里：

1. `replaceState(entry, value)`
2. 写入 `storage.set(key, state.value)`

因为整段动作都在队列里，所以不会出现：

- 内存状态先于前一个异步任务抢跑
- 前一个 `remove()` 还没结束，后一个 `set()` 先改了 state

### 4. remove

`remove()` 是命令式高优先级删除动作。

它分两段：

队列外：

1. `hasPendingSync = false`
2. `mutationVersion += 1`

这一步的作用是先撤销“尚未真正开始”的自动同步意图。

队列内：

1. `storage.remove(key)`
2. `replaceState(entry, resolveInitialValue())`

这样可以避免 watcher 已经标记过的旧 `set` 又把删除结果覆盖掉。

### 5. refresh

`refresh()` 会进入 `runQueuedStorageAction()`。

队列任务里只做一件事：

1. 执行 `hydrateEntry(entry)`

也就是说，`refresh()` 会：

- 按顺序等待前面的 `set/remove`
- 再从存储读取最新值
- 用它覆盖当前 `state`

`refresh()` 与初始化不同：

- 初始化失败只记录错误
- `refresh()` 失败会继续抛给调用方

### 6. dispose

`dispose()` 的语义是：

**释放当前 hook 这个消费者引用**

不是：

**强制销毁整个共享条目**

执行流程：

1. 当前 hook 标记自己已释放
2. 调用 `releaseEntry(entry)`
3. `consumers -= 1`
4. 如果还有其他消费者，什么都不回收
5. 如果已经是最后一个消费者，则：
   - 停掉共享 watcher
   - 从 registry 中删除条目

如果当前在响应式 scope 中，`dispose()` 会在 `onScopeDispose()` 中自动触发。

这里依赖的是 `@vue/reactivity` 的 scope 机制，而不是完整 Vue 组件环境本身。

也就是说：

- 在 Vue `setup()` 或 composable 中，通常天然存在活跃 scope
- 在普通 JS 中，只要外层是 `effectScope().run(...)`，同样会有活跃 scope
- 如果只是普通函数直接调用，没有活跃 scope，则 `getCurrentScope()` 会拿到空值，`onScopeDispose()` 不会生效

因此非 scope 场景下，需要手动调用 `dispose()`。

这个设计的目标是：

- 有 scope 时，交给宿主自动托管
- 没 scope 时，仍然允许作为通用 reactivity hook 独立使用

## 错误语义

### 初始化

- 记录到 `error`
- 不向外抛错

### set / remove / refresh

- 记录到 `error`
- Promise 继续 reject

### watcher 自动同步

- 记录到 `error`
- 不会回滚内存中的 `state`

这个设计遵循的原则是：

**内存状态是事实来源，存储是持久化副本。**

## 边界与约定

### isReady 前的使用边界

这层 hook 更适合在 `isReady.value === true` 后，再做依赖持久化值的业务判断。

### 默认值不会自动回写

如果初始化读取未命中：

- `state` 会回退到默认值
- 但不会自动把默认值写回存储

### 同页共享，不做跨标签同步

当前只保证同页内的共享状态一致性。

### dispose 是释放消费者，不是销毁条目

这点必须和 API 使用方明确。

## 当前实现的关键取舍

1. 自动持久化保留在 watcher 链路中
2. 命令式 `set/remove/refresh` 全部通过串行队列执行
3. 初始化读取和命令式 `refresh()` 共享回填逻辑，但错误语义不同
4. `remove()` 在入队前先撤销尚未开始的自动同步意图

这些取舍的核心目标都是同一个：

**让共享状态、自动同步和命令式操作在同一个条目里保持顺序一致。**
