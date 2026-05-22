# SessionSmartStorage DESIGN

这份文档说明 `SessionSmartStorage` 的运行逻辑、关键取舍和实现边界。

## 目标

`SessionSmartStorage` 的目标是提供一层“带会话生命周期的双层存储”：

- 小数据优先走 `sessionStorage`
- 大数据或 quota 命中时回退到 `IndexedDB`
- 所有持久化数据都按 `sessionId` 隔离
- 通过 `TTL + heartbeat` 判断会话是否过期

它解决的不只是“数据放哪一层”，还包括：

1. 同一浏览器上下文里的会话隔离
2. 会话过期后的数据清理
3. 避免依赖不稳定的 `beforeunload` / `unload` 做生命周期判断

## 分层模型

`SessionSmartStorage` 建立在两层数据层和一层运行时管理层之上。

### Web Storage 层

- 实现：`sessionStorage`
- 优势：同步、随标签页会话结束自然失效
- 适用：体积小于 `sizeThreshold` 的值

### 持久化回退层

- 实现：`IndexedDB`
- 优势：容量更大，适合大对象和超限回退
- 适用：
  - 数据体积本身较大
  - `sessionStorage` 写入触发 `QuotaExceededError`

### 运行时管理层

- 实现：`SessionRuntimeManager`
- 职责：
  - 生成和保存 `sessionId`
  - 维护 `lastSeenAt`
  - 启动和共享 heartbeat
  - 清理过期会话

## 基类职责

`SessionSmartStorage` 继承自 [BaseSmartStorage](/Users/leixuetian/Documents/其他/smartStorage/src/base/baseSmartStorage.ts)。

基类负责：

- `dbName / version / sizeThreshold / storageArea` 配置解析
- Web Storage 键前缀封装
- JSON 序列化与大小计算
- 共享 IndexedDB 连接生命周期

`SessionSmartStorage` 自己负责：

- `sessionStorage / IndexedDB` 分流策略
- 复合键和会话隔离
- 会话续租与清理
- `session-id` 保留键排除

## 会话运行时

### sessionId

`SessionRuntimeManager` 会在 `sessionStorage` 中维护一个保留键：

```ts
<dbName>:session-id
```

它的作用是：

- 在当前标签页会话内复用同一个 `sessionId`
- 让 `IndexedDB` 中的数据能挂到稳定的会话标识下

### touchSession()

几乎所有公开操作前都会调用 `touchSession()`。

它会在 `sessions` 仓库中写入或更新一条会话记录：

- `sessionId`
- `createdAt`
- `lastSeenAt`

这意味着会话是否存活，不是看标签页是否关闭，而是看：

**最近一次活跃时间是否仍在 TTL 内。**

### heartbeat

如果 `heartbeatInterval > 0`，runtime 会启动一个共享定时器：

1. 定期调用 `cleanupExpiredSessions()`
2. 清理超时未续租的会话及其挂载数据

runtime 不是按实例独占，而是按：

```ts
dbName + sessionId
```

共享一份状态和一条 heartbeat。

## 对象仓库

`SessionSmartStorage` 使用两个对象仓库：

### sessions

保存会话元数据：

- `sessionId`
- `createdAt`
- `lastSeenAt`

它只负责判断会话是否过期，不保存业务值。

### sessionData

保存实际业务数据：

- `compoundKey`
- `sessionId`
- `key`
- `value`

并且为 `sessionId` 建了索引，方便按会话批量查询和删除。

## 键空间

### Web Storage 层

`sessionStorage` 的真实键名格式是：

```ts
<dbName>:<key>
```

但内部还有一个保留键：

```ts
<dbName>:session-id
```

这个键不属于业务数据，因此：

- `keys()` 不会暴露它
- `clear()` 不会删除它

### IndexedDB 层

`sessionData` 使用复合主键：

```ts
<sessionId>:<key>
```

原因是：

- 同名业务键可以在不同会话里并存
- 删除和枚举时可以精准定位当前会话数据

## 写入流程

### set(key, value)

写入流程和 `LocalSmartStorage` 类似，但多了一步会话续租：

1. `touchSession()`
2. 序列化并计算体积
3. 小于阈值时优先尝试写 `sessionStorage`
4. 如果 `sessionStorage` 超限，则回退到 `IndexedDB`
5. 写进一层后，主动清理另一层旧副本

### 为什么也要保持单副本

和本地存储一样，`SessionSmartStorage` 也尽量保持单副本语义。

否则就会出现：

- 数据已经迁移到 `IndexedDB`
- `sessionStorage` 里还残留旧值
- 后续 `get()` 因为快路径优先，先读到了过期副本

因此：

- 写进 `sessionStorage` 后删 `IndexedDB`
- 写进 `IndexedDB` 后删 `sessionStorage`

## 读取流程

### get(key)

读取顺序固定是：

1. `touchSession()`
2. 先读 `sessionStorage`
3. 未命中时再读 `IndexedDB`

如果 `sessionStorage` 里的 JSON 已损坏：

1. 删除该坏副本
2. 返回 `null`

这和 `LocalSmartStorage` 保持一致。

## 删除、枚举与清空

### remove(key)

删除流程：

1. `touchSession()`
2. 删除 `sessionStorage` 副本
3. 删除当前 `sessionId` 对应的 `IndexedDB` 副本

### keys()

`keys()` 会：

1. 列出当前命名空间下的 `sessionStorage` 键
2. 排除内部 `session-id`
3. 查询 `sessionData` 里当前 `sessionId` 的全部业务键
4. 合并并去重

### clear()

`clear()` 会：

1. 清除当前命名空间下的业务 `sessionStorage` 键
2. 保留 `<dbName>:session-id`
3. 清空当前 `sessionId` 对应的 `IndexedDB` 数据

保留 `session-id` 的原因是：

- `clear()` 的目标是清业务数据
- 不是强制重建当前会话身份

## 批量操作

### setItems(items)

批量写入时：

1. 先 `touchSession()`
2. 按体积拆成小数据组和大数据组
3. 小数据先尝试写 `sessionStorage`
4. 超限项回退到 `IndexedDB`
5. 返回结果按原始输入顺序回填

### getKeys(keys)

批量读取时：

1. 先逐个查 `sessionStorage`
2. 收集未命中键
3. 对剩余键一次性查 `IndexedDB`

### removeKeys(keys)

批量删除会同时删两层，只是一次性处理多条业务键。

## 过期清理

### cleanupExpiredSessions(ttlMs?)

过期清理不是只删一条会话记录，而是两步：

1. 删除 `sessions` 里 `lastSeenAt <= cutoff` 的会话
2. 删除 `sessionData` 里这些 `sessionId` 挂载的全部数据

这里的关键规则是：

**会话失效时，业务数据也要一起失效。**

否则就会留下：

- 逻辑上不可见
- 磁盘上仍然残留

的脏数据。

## runtime 共享与释放

`SessionRuntimeManager` 会按 `dbName + sessionId` 共享 runtime。

好处是：

1. 同一会话下多个实例不会重复起 heartbeat
2. 关闭某个实例时，不会误伤其他还在使用的实例

当某个实例 `close()` 时：

1. runtime 从 owners 集合移除当前实例
2. 如果还有其他 owner，runtime 保留
3. 如果最后一个 owner 也离开：
   - 清掉 heartbeat timer
   - 从全局 runtime 缓存里删除

## 错误语义

### JSON 序列化错误

所有写入值都必须是 JSON 可序列化值。

不满足时会抛出：

- `StorageSerializationError`

### sessionStorage 超限

如果小数据写入 `sessionStorage` 时命中 `QuotaExceededError`：

- 不抛错
- 自动回退到 `IndexedDB`

### IndexedDB 失败

和本地存储一样：

- 关键读写失败通常会抛出
- 删除类操作更偏向返回 `false`

## 关键取舍

1. 小数据优先走 `sessionStorage`
2. 大数据和超限写入走 `IndexedDB`
3. `IndexedDB` 数据按 `sessionId` 隔离
4. 会话活性通过 `lastSeenAt + TTL` 判断
5. heartbeat 负责后台清理，不依赖 unload
6. `clear()` 不重建 `sessionId`

这些取舍共同保证：

**`SessionSmartStorage` 既保留会话级使用体验，又能在大数据和过期清理场景下保持可控。**
