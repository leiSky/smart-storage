import { StorageSerializationError } from '../utils/errors';
import {
  BaseSmartStorageOptions,
  ResolvedBaseSmartStorageOptions,
  SharedDbEntry,
} from '../types/internalTypes';
import { StorageValueItem } from '../types/types';

/**
 * 浏览器存储基类。
 *
 * 这里只承载两类完全通用的能力：
 * - 公共配置：dbName / version / sizeThreshold / storageArea
 * - 基础设施：JSON 序列化、大小计算、IndexedDB 连接生命周期、Web Storage 前缀封装
 *
 * 具体“数据放哪一层、怎么做回退、会话是否续租”这类策略，
 * 都继续留在各自子类里，避免基类演变成难以维护的万能抽象。
 */
abstract class BaseSmartStorage {
  /** 默认大小阈值（2MB），超过此值交给子类走 IndexedDB 流程 */
  protected static readonly DEFAULT_SIZE_THRESHOLD = 2 * 1024 * 1024;
  /** 按 dbName + version 共享数据库连接，避免同库重复打开 */
  private static readonly sharedDbs = new Map<string, SharedDbEntry>();
  /** IndexedDB 数据库名称，同时也作为 Web Storage 命名空间前缀 */
  protected readonly dbName: string;
  /** IndexedDB 版本号，变更时会触发 onupgradeneeded */
  protected readonly version: number;
  /** Web Storage 与 IndexedDB 的分流阈值 */
  protected readonly sizeThreshold: number;
  /** 当前实例操作的底层 Web Storage，实现上可以是 localStorage 或 sessionStorage */
  protected readonly storageArea: Storage;

  /** 复用编码器计算 UTF-8 字节长度，避免重复创建对象 */
  private readonly encoder = new TextEncoder();
  /** 当前实例对应的共享数据库键，用于 close() 时正确释放引用 */
  private readonly sharedDbKey: string;
  /** 标记当前实例是否还持有共享数据库引用；close 后可在后续访问时重新挂载 */
  private dbLeaseActive = false;

  /**
   * 将可选配置解析成稳定的内部配置。
   *
   * 子类和共享连接逻辑都基于这份解析后的值工作，
   * 避免默认值和显式值混用时出现行为分叉。
   */
  static resolveBaseOptions(
    options: BaseSmartStorageOptions = {},
    defaults: Pick<ResolvedBaseSmartStorageOptions, 'dbName'> = { dbName: 'SmartStorage' },
  ): ResolvedBaseSmartStorageOptions {
    return {
      dbName: options.dbName ?? defaults.dbName,
      version: options.version ?? 1,
      sizeThreshold: options.sizeThreshold ?? BaseSmartStorage.DEFAULT_SIZE_THRESHOLD,
    };
  }

  /**
   * 创建存储基类实例。
   *
   * @param options - 公共配置项；子类会在这里注入自己的默认值
   */
  constructor(options: BaseSmartStorageOptions = {}) {
    const resolvedOptions = BaseSmartStorage.resolveBaseOptions(options);
    const { storageArea = localStorage } = options;

    this.dbName = resolvedOptions.dbName;
    this.version = resolvedOptions.version;
    this.sizeThreshold = resolvedOptions.sizeThreshold;
    this.storageArea = storageArea;
    this.sharedDbKey = `${this.dbName}:${this.version}`;
    this.retainSharedDb();
    this.dbLeaseActive = true;
  }

  /**
   * 由子类声明自己的对象仓库结构。
   *
   * 基类只负责统一 open / cache / retry 逻辑，不关心 store 名称和索引细节。
   */
  protected abstract setupStores(db: IDBDatabase): void;

  // === IndexedDB 连接生命周期 ===

  /**
   * 懒加载初始化 IndexedDB 连接。
   *
   * 连接 Promise 会被缓存下来，因此：
   * - 首次访问时才真正打开数据库
   * - 并发调用会复用同一个 pending Promise
   * - 打开失败时会清掉缓存，允许下次重新尝试
   */
  protected async initDB(): Promise<IDBDatabase> {
    const sharedDb = this.ensureSharedDb();

    if (sharedDb.promise) {
      return sharedDb.promise;
    }

    sharedDb.promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        this.setupStores((event.target as IDBOpenDBRequest).result);
      };

      request.onsuccess = (event) => {
        resolve((event.target as IDBOpenDBRequest).result);
      };

      request.onerror = (event) => {
        const currentEntry = BaseSmartStorage.sharedDbs.get(this.sharedDbKey);
        if (currentEntry) {
          currentEntry.promise = null;
        }
        reject(new Error(`IndexedDB open failed: ${(event.target as IDBOpenDBRequest).error?.message}`));
      };
    });

    return sharedDb.promise;
  }

  /**
   * 关闭当前实例持有的 IndexedDB 连接。
   *
   * 子类如果还有额外资源需要释放，应先处理自己的资源，再调用 super.close()。
   */
  async close(): Promise<void> {
    if (!this.dbLeaseActive) {
      return;
    }

    this.dbLeaseActive = false;
    await this.releaseSharedDb();
  }

  // === JSON 序列化辅助 ===

  /**
   * 将值序列化为 JSON 字符串。
   *
   * 整个项目统一以“JSON 可序列化”作为可存储值的边界，
   * 这样 local / session / IndexedDB 的表现就能保持一致。
   */
  protected serialize(data: unknown): string {
    try {
      const serialized = JSON.stringify(data);
      if (serialized === undefined) {
        throw new StorageSerializationError();
      }
      return serialized;
    } catch {
      throw new StorageSerializationError();
    }
  }

  /**
   * 计算序列化后字符串的 UTF-8 字节大小。
   *
   * 子类先序列化、再复用这个方法计算大小，就能避免一次写入里重复 stringify。
   */
  protected getSize(serialized: string): number {
    return this.encoder.encode(serialized).length;
  }

  // === Web Storage 前缀封装 ===

  /**
   * 生成当前实例在 Web Storage 中使用的真实键名。
   *
   * dbName 既承担 IndexedDB 数据库名，也承担 Web Storage 命名空间，
   * 这样 keys()/clear() 才不会误伤别的实例或别的业务数据。
   */
  protected getStorageKey(key: string): string {
    return `${this.dbName}:${key}`;
  }

  /**
   * 子类可以在这里排除自己的保留键。
   *
   * 基类默认只按命名空间过滤；像 session 这种还带内部元数据 key 的实现，
   * 可以覆盖这个钩子，把“哪些键算当前实例真正管理的数据”说清楚。
   */
  protected isManagedStorageKey(storageKey: string): boolean {
    return storageKey.startsWith(`${this.dbName}:`);
  }

  /**
   * 获取当前实例真正管理的所有 Web Storage 键。
   *
   * 子类如果有保留键，可以通过覆写 isManagedStorageKey() 排除掉。
   */
  protected getStorageKeys(): string[] {
    return Object.keys(this.storageArea).filter((storageKey) => this.isManagedStorageKey(storageKey));
  }

  /**
   * 把真实键名还原成对外暴露的业务键名。
   */
  protected getPublicKey(storageKey: string): string {
    return storageKey.slice(this.dbName.length + 1);
  }

  // === Web Storage 操作 ===

  /** 对底层 Web Storage 的统一写封装，方便子类不直接依赖具体实现。 */
  protected webSetItem(key: string, value: string): void {
    this.storageArea.setItem(key, value);
  }

  /** 对底层 Web Storage 的统一读封装。 */
  protected webGetItem(key: string): string | null {
    return this.storageArea.getItem(key);
  }

  /** 对底层 Web Storage 的统一删封装。 */
  protected webRemoveItem(key: string): void {
    this.storageArea.removeItem(key);
  }

  // === IndexedDB 基础操作 ===

  /**
   * 批量写入到指定对象仓库。
   *
   * 基类只处理“用 key 作为主键的普通写入”这层共性，
   * 如果子类需要复合主键或附加字段，应自行实现专用写入逻辑。
   */
  protected async idbSave<T>(
    storeName: string,
    items: StorageValueItem<T>[],
  ): Promise<void> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      for (const { key, value } of items) {
        store.put({ key, value } as StorageValueItem<T>);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 批量读取指定对象仓库中的键。
   *
   * 所有未命中的键都会显式返回 null，方便子类保持批量读取结果结构稳定。
   */
  protected async idbGet<T>(
    storeName: string,
    keys: string[],
  ): Promise<Record<string, T | null>> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const result: Record<string, T | null> = {};

      for (const key of keys) {
        result[key] = null;
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result as StorageValueItem<T> | undefined;
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
   * 批量删除指定对象仓库中的键。
   */
  protected async idbDelete(
    storeName: string,
    keys: string[],
  ): Promise<void> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      for (const key of keys) {
        store.delete(key);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 清空指定对象仓库。
   */
  protected async idbClear(storeName: string): Promise<void> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 获取指定对象仓库的全部主键。
   */
  protected async idbGetAllKeys(storeName: string): Promise<string[]> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAllKeys();

      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 为当前实例占用的共享数据库增加一个引用。
   */
  private retainSharedDb(): void {
    const sharedDb = BaseSmartStorage.sharedDbs.get(this.sharedDbKey);

    if (sharedDb) {
      sharedDb.ownerCount += 1;
      return;
    }

    BaseSmartStorage.sharedDbs.set(this.sharedDbKey, {
      ownerCount: 1,
      promise: null,
    });
  }

  /**
   * 确保当前实例已经挂上共享数据库引用。
   *
   * 这让实例在 close() 之后仍然可以被再次使用：
   * 下一次真正触发 IndexedDB 访问时，会自动重新加入共享连接池。
   */
  private ensureSharedDb(): SharedDbEntry {
    if (!this.dbLeaseActive) {
      this.retainSharedDb();
      this.dbLeaseActive = true;
    }

    const sharedDb = BaseSmartStorage.sharedDbs.get(this.sharedDbKey);
    if (!sharedDb) {
      throw new Error(`Shared DB entry missing for key: ${this.sharedDbKey}`);
    }

    return sharedDb;
  }

  /**
   * 释放当前实例占用的共享数据库引用。
   *
   * 只有最后一个实例关闭时，才真正关闭底层数据库连接。
   */
  private async releaseSharedDb(): Promise<void> {
    const sharedDb = BaseSmartStorage.sharedDbs.get(this.sharedDbKey);

    if (!sharedDb) {
      return;
    }

    sharedDb.ownerCount -= 1;
    if (sharedDb.ownerCount > 0) {
      return;
    }

    BaseSmartStorage.sharedDbs.delete(this.sharedDbKey);

    if (sharedDb.promise) {
      const db = await sharedDb.promise;
      db.close();
    }
  }
}

export default BaseSmartStorage;
