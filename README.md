# smart-storage

面向浏览器的双层存储工具库：

- `LocalSmartStorage`：小数据优先走 `localStorage`，大数据或 quota 命中时自动降级到 `IndexedDB`
- `SessionSmartStorage`：小数据优先走 `sessionStorage`，大数据写入 `IndexedDB`，并通过 `sessionId + TTL + heartbeat` 做会话隔离与过期清理
- `StorageSerializationError`：当写入值不可 JSON 序列化时抛出的明确错误类型

## 安装

```bash
npm install smart-storage
```

## 导出入口

根入口只提供命名导出，没有默认导出：

```ts
import {
  LocalSmartStorage,
  SessionSmartStorage,
  StorageSerializationError,
} from 'smart-storage';
import type {
  LocalSmartStorageOptions,
  SessionSmartStorageOptions,
  LocalStorageResult,
  SessionStorageResult,
  StorageValueItem,
} from 'smart-storage';
```

如果你希望直接使用子入口，也可以：

```ts
import LocalSmartStorage from 'smart-storage/local';
import SessionSmartStorage from 'smart-storage/session';
```

## 快速开始

### 本地持久存储

```ts
import { LocalSmartStorage } from 'smart-storage';

const storage = new LocalSmartStorage({
  dbName: 'MyApp',
  version: 1,
});

await storage.set('user', { name: '张三' });

const user = await storage.get<{ name: string }>('user');
console.log(user?.name);
```

如果你希望更早把数据导向 `IndexedDB`，可以降低阈值：

```ts
const storage = new LocalSmartStorage({
  dbName: 'MyApp',
  sizeThreshold: 64 * 1024,
});
```

### 会话级存储

```ts
import { SessionSmartStorage } from 'smart-storage';

const storage = new SessionSmartStorage({
  dbName: 'MyApp',
  sessionTTL: 5 * 60 * 1000,
  heartbeatInterval: 30 * 1000,
});

await storage.set('draft', { title: '草稿标题' });

const draft = await storage.get<{ title: string }>('draft');
console.log(draft?.title);
```

会话数据会按当前标签页的 `sessionId` 隔离；超过 `sessionTTL` 且未续租的会话，可以通过 `cleanupExpiredSessions()` 清理。

## 配置项

### `LocalSmartStorageOptions`

- `dbName?: string`：命名空间和 IndexedDB 数据库名，默认 `SmartStorage`
- `version?: number`：IndexedDB 版本号，默认 `1`
- `sizeThreshold?: number`：超过该字节阈值后优先写入 `IndexedDB`，默认 `2 * 1024 * 1024`

### `SessionSmartStorageOptions`

- 继承 `LocalSmartStorageOptions` 的 `dbName` / `version` / `sizeThreshold`
- `sessionTTL?: number`：会话失活时间，默认 `5 * 60 * 1000`
- `heartbeatInterval?: number`：自动续租周期，默认 `30 * 1000`；设为 `0` 可关闭自动心跳

## 常用 API

两个存储类都提供以下公开方法：

- `set(key, value)`：写入单条数据
- `get(key)`：读取单条数据
- `remove(key)`：删除单条数据
- `has(key)`：判断键是否存在
- `keys()`：列出当前实例可见的业务键
- `clear()`：清空当前实例管理的数据
- `setItems(items)`：批量写入
- `getKeys(keys)`：批量读取
- `removeKeys(keys)`：批量删除
- `close()`：释放当前实例持有的共享资源；当实例生命周期明确结束时，推荐显式调用

`SessionSmartStorage` 额外提供：

- `cleanupExpiredSessions(ttlMs?)`：清理过期会话及其挂载数据

其中：

- `LocalSmartStorage.close()` 会释放当前实例持有的共享 IndexedDB 引用
- `SessionSmartStorage.close()` 除了释放共享 IndexedDB 引用，还会释放会话 runtime 和可能存在的心跳定时器

## 返回值与类型

```ts
type LocalStorageResult = {
  success: boolean;
  source: 'localStorage' | 'IndexedDB';
};

type SessionStorageResult = {
  success: boolean;
  source: 'sessionStorage' | 'IndexedDB';
};

interface StorageValueItem<T = unknown> {
  key: string;
  value: T;
}
```

`source` 字段可以帮助你判断一条数据最终落在了哪一层存储。

## 错误处理

库只接受 JSON 可序列化值，例如字符串、数字、布尔值、`null`、普通对象和数组。

以下值不受支持：

- 顶层 `undefined`
- 循环引用对象
- 函数
- `Symbol`

传入这类值时会抛出 `StorageSerializationError`：

```ts
import { LocalSmartStorage, StorageSerializationError } from 'smart-storage';

const storage = new LocalSmartStorage();

try {
  await storage.set('bad', undefined);
} catch (error) {
  if (error instanceof StorageSerializationError) {
    console.error(error.message);
  }
}
```

## 行为说明

- Web Storage 中的业务键会带上 `<dbName>:<key>` 前缀，避免不同实例互相污染
- 当同一个 key 在 Web Storage 和 IndexedDB 之间迁移时，会主动清理旧副本，尽量保持单副本语义
- 读取顺序固定优先走 Web Storage，再回退到 IndexedDB
- `SessionSmartStorage.clear()` 不会删除内部 `session-id` 保留键，因此清空后当前会话身份仍保持不变

## 开发脚本

```bash
npm run build
npm test
npm run check
```

- `build`：从 `src/` 构建 `dist/` 下的 ESM 和类型声明
- `test`：运行全部单元测试
- `check`：先构建再测试

`prepublishOnly` 已绑定到 `npm run check`，发布前会自动执行完整校验。
