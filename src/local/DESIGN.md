# LocalSmartStorage DESIGN

这份文档说明 `LocalSmartStorage` 的运行逻辑、关键取舍和实现边界。

## 目标

`LocalSmartStorage` 的目标是提供一层“本地双层存储”：

- 小数据优先走 `localStorage`
- 大数据或 quota 命中时回退到 `IndexedDB`

这样做的核心收益是：

1. 常见小数据读取更快
2. 大数据不受 `localStorage` 容量限制
3. 调用方只面对一套统一 API，不需要自己区分存储层

## 分层模型

`LocalSmartStorage` 建立在两层存储之上：

### Web Storage 层

- 实现：`localStorage`
- 优势：同步、读取快、适合小数据
- 适用：体积小于 `sizeThreshold` 的值

### 持久化回退层

- 实现：`IndexedDB`
- 优势：容量更大、适合大对象
- 适用：
  - 数据体积本身较大
  - `localStorage` 写入时触发 `QuotaExceededError`

## 基类职责

`LocalSmartStorage` 继承自 [BaseSmartStorage](/Users/leixuetian/Documents/其他/smartStorage/src/base/baseSmartStorage.ts)。

基类负责：

- `dbName / version / sizeThreshold / storageArea` 配置解析
- Web Storage 键前缀封装
- JSON 序列化与大小计算
- 共享 IndexedDB 连接生命周期
- 通用的 `idbSave / idbGet / idbDelete / idbClear / idbGetAllKeys`

`LocalSmartStorage` 自己负责：

- localStorage / IndexedDB 之间的分流策略
- 迁移时如何保持单副本语义
- 对外的单项 / 批量业务 API

## 对象仓库

`LocalSmartStorage` 只使用一个对象仓库：

- `localStore`

结构很简单：

- `key`
- `value`

没有额外索引，因为它不需要会话维度或复合查询。

## 键空间

Web Storage 层的真实键名格式是：

```ts
<dbName>:<key>
```

原因是：

- 避免不同实例互相污染
- 方便 `keys()` / `clear()` 只处理当前命名空间的数据

`IndexedDB` 中保存的业务键仍然是原始 `key`，不再重复加前缀。

## 写入流程

### set(key, value)

单条写入的判断流程：

1. 先把值 JSON 序列化
2. 计算 UTF-8 字节大小
3. 如果小于 `sizeThreshold`
   - 先尝试写入 `localStorage`
   - 成功后顺手删除 `IndexedDB` 旧副本
4. 如果写入 `localStorage` 时命中 `QuotaExceededError`
   - 回退到 `IndexedDB`
5. 如果本身体积已经超过阈值
   - 直接写入 `IndexedDB`
6. 写入 `IndexedDB` 成功后
   - 立即删除 `localStorage` 旧副本

### 为什么写完一层还要删另一层

这是当前实现里最重要的规则之一：

**尽量保持单副本语义。**

如果不删旧副本，就会出现：

- 值已经迁移到 `IndexedDB`
- 但 `localStorage` 还残留旧值
- 后续 `get()` 先读 `localStorage`，反而拿到过期结果

因此：

- 写进 `localStorage` 后删 `IndexedDB`
- 写进 `IndexedDB` 后删 `localStorage`

## 读取流程

### get(key)

读取顺序固定是：

1. 先读 `localStorage`
2. 未命中时再读 `IndexedDB`

如果 `localStorage` 里的值无法 JSON 解析：

1. 认为该副本已损坏
2. 立即删除这个坏值
3. 返回 `null`

### 为什么不在解析失败后继续回退 IndexedDB

当前实现采取的是保守策略：

- 本层值坏了就清掉
- 本次读取返回 `null`

这样做更简单，也避免在“双副本可能已分叉”的情况下继续猜测谁是真值。

## 删除与存在性判断

### remove(key)

删除会同时处理两层：

1. 删除 `localStorage`
2. 尝试删除 `IndexedDB`

如果 `IndexedDB` 删除失败：

- 返回 `false`
- 不继续抛错

### has(key)

判断顺序和读取一致：

1. 先查 `localStorage`
2. 再查 `IndexedDB`

## 枚举与清空

### keys()

`keys()` 会：

1. 枚举当前命名空间下的 `localStorage` 键
2. 读取 `IndexedDB` 的全部业务键
3. 合并并去重

### clear()

`clear()` 会：

1. 删除当前命名空间下的全部 `localStorage` 键
2. 清空 `localStore`

## 批量操作

### setItems(items)

批量写入时，会先按体积分两组：

- 小数据组 -> `localStorage`
- 大数据组 -> `IndexedDB`

如果小数据组中个别项写 `localStorage` 时超限：

- 这些项会被重新放进 `IndexedDB` 组

返回结果会按原始输入顺序回填，保证调用方能把每个结果和原输入一一对应。

### getKeys(keys)

批量读取时：

1. 先逐个检查 `localStorage`
2. 把未命中的键收集起来
3. 对剩余键一次性查询 `IndexedDB`

### removeKeys(keys)

批量删除会同时删两层，只是封装成一次批量操作。

## 错误语义

### JSON 序列化错误

所有写入值都必须是 JSON 可序列化值。

不满足时会抛出：

- `StorageSerializationError`

### localStorage 容量错误

当小数据写 `localStorage` 命中 `QuotaExceededError` 时：

- 不抛错
- 自动回退到 `IndexedDB`

### IndexedDB 操作错误

不同 API 处理略有区别：

- `set/get/has/keys/clear/setItems/getKeys/removeKeys` 里的关键失败通常会抛出
- `remove/removeKeys` 这类删除型操作更倾向于返回 `false`

## 关键取舍

1. 小数据优先走 `localStorage`
2. 大数据和超限写入走 `IndexedDB`
3. 迁移时主动清理旧副本
4. 读取固定先查 Web Storage，再查 IndexedDB

这些取舍共同保证：

**调用方始终面对一套统一 API，同时尽量保留“小数据快、大数据稳”的行为。**
