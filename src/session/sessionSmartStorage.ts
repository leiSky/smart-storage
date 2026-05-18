import BaseSmartStorage from '../base/baseSmartStorage';
import { StorageSerializationError } from '../utils/errors';
import {
  SessionDataItem,
} from '../types/internalTypes';
import SessionRuntimeManager from './sessionRuntimeManager';
import {
  SessionSmartStorageOptions,
  SessionStorageResult,
  StorageValueItem,
} from '../types/types';

export { StorageSerializationError };

/**
 * 会话级智能存储。
 *
 * 核心策略：
 * - 小数据优先写 sessionStorage，随标签页会话结束自动失效
 * - 大数据写 IndexedDB，但按 sessionId 隔离
 * - 用 lastSeenAt 心跳 + TTL 判断会话是否过期，而不是依赖不稳定的 unload 事件
 */
class SessionSmartStorage extends BaseSmartStorage {
  /** 会话生命周期、心跳和清理逻辑由独立 manager 负责 */
  private readonly runtime: SessionRuntimeManager;
  /** 活跃会话对象仓库 */
  private readonly sessionsStoreName = 'sessions';
  /** 会话级数据对象仓库 */
  private readonly dataStoreName = 'sessionData';

  /**
   * 创建会话级智能存储实例。
   *
   * @param options - 会话存储公开配置；底层固定使用 sessionStorage 作为 Web Storage 层
   */
  constructor(options: SessionSmartStorageOptions = {}) {
    const resolvedOptions = SessionRuntimeManager.resolveOptions(options);

    super({ ...resolvedOptions, storageArea: sessionStorage });
    this.runtime = new SessionRuntimeManager({
      options: resolvedOptions,
      sessionStorage,
      initDB: () => this.initDB(),
      heartbeatOwner: {
        cleanupExpiredSessions: (ttlMs?: number) => this.cleanupExpiredSessions(ttlMs),
      },
    });
  }

  /**
   * 把内部 sessionId 保留键排除在实例可见数据之外。
   *
   * 这样 keys()/clear() 只会面向业务数据，不会把会话元数据暴露给调用方。
   */
  protected override isManagedStorageKey(storageKey: string): boolean {
    return super.isManagedStorageKey(storageKey) && storageKey !== this.runtime.sessionIdStorageKey;
  }

  // === 键空间与对象仓库 ===

  /**
   * 生成当前会话在 IndexedDB 中的复合主键。
   *
   * 同一个业务 key 只有挂上 sessionId，才能在不同会话里并存而不串读。
   */
  private getCompoundKey(key: string): string {
    return `${this.runtime.sessionId}:${key}`;
  }

  /**
   * 声明 SessionSmartStorage 需要的对象仓库和索引。
   */
  protected setupStores(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(this.sessionsStoreName)) {
      db.createObjectStore(this.sessionsStoreName, { keyPath: 'sessionId' });
    }

    if (!db.objectStoreNames.contains(this.dataStoreName)) {
      const store = db.createObjectStore(this.dataStoreName, { keyPath: 'compoundKey' });
      store.createIndex('sessionId', 'sessionId', { unique: false });
    }
  }

  /**
   * 批量写入当前会话的数据到 IndexedDB。
   */
  private async saveToIDB<T>(items: StorageValueItem<T>[]): Promise<SessionStorageResult[]> {
    const db = await this.initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.dataStoreName], 'readwrite');
      const store = transaction.objectStore(this.dataStoreName);

      for (const { key, value } of items) {
        store.put({
          compoundKey: this.getCompoundKey(key),
          sessionId: this.runtime.sessionId,
          key,
          value,
        } as SessionDataItem<T>);
      }

      transaction.oncomplete = () => {
        resolve(items.map(() => ({ success: true, source: 'IndexedDB' as const })));
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 批量读取当前会话在 IndexedDB 中的数据。
   */
  private async getFromIDB<T>(keys: string[]): Promise<Record<string, T | null>> {
    const db = await this.initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.dataStoreName], 'readonly');
      const store = transaction.objectStore(this.dataStoreName);
      const result: Record<string, T | null> = {};

      for (const key of keys) {
        result[key] = null;
        const request = store.get(this.getCompoundKey(key));

        request.onsuccess = () => {
          const record = request.result as SessionDataItem<T> | undefined;
          if (record) {
            result[key] = record.value;
          }
        };
      }

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 批量删除当前会话在 IndexedDB 中的数据。
   */
  private async deleteFromIDB(keys: string[]): Promise<void> {
    const db = await this.initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.dataStoreName], 'readwrite');
      const store = transaction.objectStore(this.dataStoreName);

      for (const key of keys) {
        store.delete(this.getCompoundKey(key));
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 获取当前会话在 IndexedDB 中保存的全部业务键。
   */
  private async getKeysFromIDB(): Promise<string[]> {
    const db = await this.initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.dataStoreName], 'readonly');
      const store = transaction.objectStore(this.dataStoreName);
      const index = store.index('sessionId');
      const request = index.getAll(IDBKeyRange.only(this.runtime.sessionId));

      request.onsuccess = () => {
        const records = request.result as SessionDataItem[];
        resolve(records.map((record) => record.key));
      };
      request.onerror = () => reject(request.error);
    });
  }

  // === 会话清理 ===

  /**
   * 清理超时未续租的会话及其挂载数据。
   *
   * 这里删除的不只是会话记录本身，还会把该 sessionId 下的数据一并清掉，
   * 否则只会变成“逻辑失效但磁盘残留”的脏数据。
   */
  async cleanupExpiredSessions(ttlMs = this.runtime.sessionTTL): Promise<number> {
    return this.runtime.cleanupExpiredSessions(ttlMs);
  }

  // === 单项操作 ===

  /**
   * 写入单条数据。
   *
   * 会话层的选择策略与 LocalSmartStorage 类似，
   * 但 IndexedDB 数据会额外挂上 sessionId 做隔离。
   */
  async set<T>(key: string, value: T): Promise<SessionStorageResult> {
    await this.runtime.touchSession();
    const serialized = this.serialize(value);
    const size = this.getSize(serialized);
    const storageKey = this.getStorageKey(key);

    if (size < this.sizeThreshold) {
      try {
        this.webSetItem(storageKey, serialized);
        try {
          // 小数据成功落到 sessionStorage 后，顺手删掉 IndexedDB 旧副本。
          await this.deleteFromIDB([key]);
        } catch {
        }
        return { success: true, source: 'sessionStorage' };
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') {
          throw error;
        }
      }
    }

    const results = await this.saveToIDB([{ key, value }]);
    // 数据转存到 IndexedDB 后，要清理 sessionStorage 旧值，
    // 否则后续读操作会因为快路径优先而拿到过期副本。
    this.webRemoveItem(storageKey);
    return results[0];
  }

  /**
   * 读取单条数据。
   *
   * 读取顺序固定是 sessionStorage -> IndexedDB。
   */
  async get<T>(key: string): Promise<T | null> {
    await this.runtime.touchSession();
    const storageKey = this.getStorageKey(key);
    const localData = this.webGetItem(storageKey);

    if (localData !== null) {
      try {
        return JSON.parse(localData) as T;
      } catch {
        this.webRemoveItem(storageKey);
        return null;
      }
    }

    const result = await this.getFromIDB<T>([key]);
    return result[key];
  }

  /**
   * 删除单条数据。
   */
  async remove(key: string): Promise<boolean> {
    await this.runtime.touchSession();
    this.webRemoveItem(this.getStorageKey(key));

    try {
      await this.deleteFromIDB([key]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 判断键是否存在。
   */
  async has(key: string): Promise<boolean> {
    await this.runtime.touchSession();

    if (this.webGetItem(this.getStorageKey(key)) !== null) {
      return true;
    }

    const result = await this.getFromIDB([key]);
    return result[key] !== null;
  }

  // === 集合操作 ===

  /**
   * 枚举当前会话的全部业务键。
   *
   * sessionStorage 的保留元数据键已经在基类过滤钩子里排除，
   * 这里可以直接按“业务可见键”来合并两层结果。
   */
  async keys(): Promise<string[]> {
    await this.runtime.touchSession();
    const sessionKeys = this.getStorageKeys().map((key) => this.getPublicKey(key));
    const dbKeys = await this.getKeysFromIDB();
    return [...new Set([...sessionKeys, ...dbKeys])];
  }

  /**
   * 清空当前会话的全部业务数据。
   *
   * 这里不会删除 session-id 保留键，因此 clear() 后当前会话身份仍然保持不变。
   */
  async clear(): Promise<void> {
    await this.runtime.touchSession();

    for (const key of this.getStorageKeys()) {
      this.webRemoveItem(key);
    }

    try {
      await this.deleteFromIDB(await this.getKeysFromIDB());
    } catch {
    }
  }

  /**
   * 批量写入数据。
   *
   * 会先按体积分类，再分别写入 sessionStorage 或 IndexedDB，
   * 返回结果同样严格按输入顺序回填。
   */
  async setItems<T>(items: StorageValueItem<T>[]): Promise<SessionStorageResult[]> {
    await this.runtime.touchSession();
    const sessionItems: Array<{ index: number; key: string; storageKey: string; value: T; serialized: string }> = [];
    const idbItems: Array<{ index: number; key: string; storageKey: string; value: T; serialized: string }> = [];

    for (const [index, item] of items.entries()) {
      const serialized = this.serialize(item.value);
      if (this.getSize(serialized) < this.sizeThreshold) {
        sessionItems.push({
          index,
          key: item.key,
          storageKey: this.getStorageKey(item.key),
          value: item.value,
          serialized,
        });
      } else {
        idbItems.push({
          index,
          key: item.key,
          storageKey: this.getStorageKey(item.key),
          value: item.value,
          serialized,
        });
      }
    }

    const results: Array<SessionStorageResult | undefined> = new Array(items.length);

    for (const { index, key, storageKey, value, serialized } of sessionItems) {
      try {
        this.webSetItem(storageKey, serialized);
        results[index] = { success: true, source: 'sessionStorage' };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'QuotaExceededError') {
          idbItems.push({ index, key, storageKey, value, serialized });
        } else {
          throw error;
        }
      }
    }

    if (sessionItems.length > 0) {
      try {
        // 本轮成功写入 sessionStorage 的项，要删掉旧的 IndexedDB 副本。
        await this.deleteFromIDB(sessionItems.map(({ key }) => key));
      } catch {
      }
    }

    if (idbItems.length > 0) {
      const idbResults = await this.saveToIDB(idbItems.map(({ key, value }) => ({ key, value })));
      for (let i = 0; i < idbItems.length; i++) {
        // 转存到 IndexedDB 后，移除 sessionStorage 旧值，保持单副本语义。
        this.webRemoveItem(idbItems[i].storageKey);
        results[idbItems[i].index] = idbResults[i];
      }
    }

    return results as SessionStorageResult[];
  }

  /**
   * 批量读取数据。
   *
   * 先走 sessionStorage 快路径，再把未命中的键批量交给 IndexedDB。
   */
  async getKeys<T>(keys: string[]): Promise<Record<string, T | null>> {
    await this.runtime.touchSession();
    const result: Record<string, T | null> = {};
    const missingKeys: string[] = [];

    for (const key of keys) {
      const localData = this.webGetItem(this.getStorageKey(key));
      if (localData !== null) {
        try {
          result[key] = JSON.parse(localData) as T;
        } catch {
          this.webRemoveItem(this.getStorageKey(key));
          missingKeys.push(key);
        }
      } else {
        missingKeys.push(key);
      }
    }

    if (missingKeys.length > 0) {
      const idbResults = await this.getFromIDB<T>(missingKeys);
      Object.assign(result, idbResults);
    }

    return result;
  }

  /**
   * 批量删除数据。
   */
  async removeKeys(keys: string[]): Promise<void> {
    await this.runtime.touchSession();

    for (const key of keys) {
      this.webRemoveItem(this.getStorageKey(key));
    }

    try {
      await this.deleteFromIDB(keys);
    } catch {
    }
  }

  /**
   * 关闭当前实例。
   *
   * 关闭时会先释放共享会话运行时引用，再关闭共享 IndexedDB 连接引用。
   */
  async close(): Promise<void> {
    await this.runtime.close();
    await super.close();
  }
}

export default SessionSmartStorage;
