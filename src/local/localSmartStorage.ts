import BaseSmartStorage from '../base/baseSmartStorage';
import { StorageSerializationError } from '../utils/errors';
import { LocalSmartStorageOptions, LocalStorageResult, StorageValueItem } from '../types/types';

export { StorageSerializationError };

/**
 * 本地持久智能存储。
 *
 * 核心策略：
 * - 小数据优先写 localStorage，读取更快
 * - 大数据或 quota 命中时落到 IndexedDB
 * - 同一个业务 key 在两个存储层之间迁移时，会主动清理旧副本
 */
class LocalSmartStorage extends BaseSmartStorage {
  /** 本地持久存储的主对象仓库 */
  private readonly storeName = 'localStore';

  /**
   * 创建本地持久存储实例。
   *
   * @param options - 本地存储公开配置；底层固定使用 localStorage 作为 Web Storage 层
   */
  constructor(options: LocalSmartStorageOptions = {}) {
    super({ ...options, storageArea: localStorage });
  }

  // === IndexedDB 结构声明 ===

  /**
   * 声明 LocalSmartStorage 需要的对象仓库。 
   */
  protected setupStores(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(this.storeName)) {
      db.createObjectStore(this.storeName, { keyPath: 'key' });
    }
  }

  // === IndexedDB 辅助 ===

  /**
   * 获取当前实例在 IndexedDB 中保存的全部业务键。
   */
  private async getKeysFromIDB(): Promise<string[]> {
    return this.idbGetAllKeys(this.storeName);
  }

  // === 单项操作 ===

  /**
   * 写入单条数据。
   *
   * 流程是：
   * - 小数据先尝试 localStorage
   * - localStorage 超限时降级到 IndexedDB
   * - 大数据直接写 IndexedDB
   */
  async set<T>(key: string, value: T): Promise<LocalStorageResult> {
    const serialized = this.serialize(value);
    const size = this.getSize(serialized);
    const storageKey = this.getStorageKey(key);

    if (size < this.sizeThreshold) {
      try {
        this.webSetItem(storageKey, serialized);
        try {
          // 主写入已经成功，旧副本清理失败不影响本次返回结果。
          await this.idbDelete(this.storeName, [key]);
        } catch {
        }
        return { success: true, source: 'localStorage' };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          console.warn(`localStorage quota exceeded, fallback to IndexedDB for key: ${key}`);
        } else {
          throw e;
        }
      }
    }

    await this.idbSave(this.storeName, [{ key, value }]);
    // 数据转存到 IndexedDB 后，立即清掉 Web Storage 旧副本，
    // 避免后续读操作因为“先读 localStorage”而拿到旧值。
    this.webRemoveItem(storageKey);
    return { success: true, source: 'IndexedDB' };
  }

  /**
   * 读取单条数据。
   *
   * 读取顺序固定是 localStorage -> IndexedDB。
   */
  async get<T>(key: string): Promise<T | null> {
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

    const result = await this.idbGet<T>(this.storeName, [key]);
    return result[key];
  }

  /**
   * 删除单条数据。
   *
   * 两层都会删；IndexedDB 删除失败时返回 false，而不是抛错。
   */
  async remove(key: string): Promise<boolean> {
    this.webRemoveItem(this.getStorageKey(key));

    try {
      await this.idbDelete(this.storeName, [key]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 判断键是否存在。
   */
  async has(key: string): Promise<boolean> {
    if (this.webGetItem(this.getStorageKey(key)) !== null) {
      return true;
    }

    const result = await this.idbGet(this.storeName, [key]);
    return result[key] !== null;
  }

  // === 集合操作 ===

  /**
   * 枚举当前实例管理的全部业务键。
   *
   * localStorage 和 IndexedDB 的结果会合并并去重。
   */
  async keys(): Promise<string[]> {
    const localKeys = this.getStorageKeys().map((key) => this.getPublicKey(key));
    const dbKeys = await this.getKeysFromIDB();
    return [...new Set([...localKeys, ...dbKeys])];
  }

  /**
   * 清空当前实例的全部数据。
   */
  async clear(): Promise<void> {
    for (const key of this.getStorageKeys()) {
      this.webRemoveItem(key);
    }
    await this.idbClear(this.storeName);
  }

  /**
   * 批量写入数据。
   *
   * 每个元素会先按体积分类，再分别落到 localStorage 或 IndexedDB。
   * 返回结果严格按输入顺序回填，避免调用方把 source 和原始数据对错位。
   */
  async setItems<T>(items: StorageValueItem<T>[]): Promise<LocalStorageResult[]> {
    const localItems: Array<{ index: number; key: string; storageKey: string; value: T; serialized: string }> = [];
    const idbItems: Array<{ index: number; key: string; storageKey: string; value: T; serialized: string }> = [];

    for (const [index, item] of items.entries()) {
      const serialized = this.serialize(item.value);
      if (this.getSize(serialized) < this.sizeThreshold) {
        localItems.push({
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

    const results: Array<LocalStorageResult | undefined> = new Array(items.length);

    for (const { index, key, storageKey, value, serialized } of localItems) {
      try {
        this.webSetItem(storageKey, serialized);
        results[index] = { success: true, source: 'localStorage' };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          idbItems.push({ index, key, storageKey, value, serialized });
        } else {
          throw e;
        }
      }
    }

    if (localItems.length > 0) {
      try {
        // 本轮成功写进 localStorage 的 key，要顺手删掉 IndexedDB 旧副本。
        await this.idbDelete(this.storeName, localItems.map(({ key }) => key));
      } catch {
      }
    }

    if (idbItems.length > 0) {
      await this.idbSave(this.storeName, idbItems.map(({ key, value }) => ({ key, value })));
      for (let i = 0; i < idbItems.length; i++) {
        // 数据转存到 IndexedDB 后，移除 Web Storage 旧值，保持单副本语义。
        this.webRemoveItem(idbItems[i].storageKey);
        results[idbItems[i].index] = { success: true, source: 'IndexedDB' };
      }
    }

    return results as LocalStorageResult[];
  }

  /**
   * 批量读取数据。
   *
   * 先从 localStorage 命中快路径，剩余未命中的键再一次性查询 IndexedDB。
   */
  async getKeys<T>(keys: string[]): Promise<Record<string, T | null>> {
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
      const idbResults = await this.idbGet<T>(this.storeName, missingKeys);
      Object.assign(result, idbResults);
    }

    return result;
  }

  /**
   * 批量删除数据。
   */
  async removeKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.webRemoveItem(this.getStorageKey(key));
    }

    try {
      await this.idbDelete(this.storeName, keys);
    } catch {
    }
  }
}

export default LocalSmartStorage;
