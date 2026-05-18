import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import LocalSmartStorage, { StorageSerializationError } from '../src/local/localSmartStorage.ts';

describe('LocalSmartStorage', () => {
  let storage: LocalSmartStorage;

  const getRawIDBValue = async (dbName: string, key: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    try {
      if (!db.objectStoreNames.contains('store')) {
        return null;
      }

      return await new Promise<unknown | null>((resolve, reject) => {
        const transaction = db.transaction(['store'], 'readonly');
        const store = transaction.objectStore('store');
        const request = store.get(key);

        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    // 创建新的存储实例
    storage = new LocalSmartStorage({ dbName: 'TestDB', version: 1 });
  });

  afterEach(async () => {
    // 清理 localStorage
    localStorage.clear();
    // 清理并关闭
    await storage.clear();
    await storage.close();
  });

  describe('基础存储操作', () => {
    it('set/get - 存储和获取字符串', async () => {
      const result = await storage.set('name', '张三');
      expect(result.success).toBe(true);
      expect(result.source).toBe('localStorage');

      const value = await storage.get<string>('name');
      expect(value).toBe('张三');
    });

    it('set/get - 存储和获取对象', async () => {
      const user = { name: '李四', age: 25, tags: ['admin', 'user'] };
      const result = await storage.set('user', user);
      expect(result.success).toBe(true);

      const value = await storage.get<typeof user>('user');
      expect(value).toEqual(user);
    });

    it('set/get - 存储和获取数组', async () => {
      const list = [1, 2, 3, { a: 'b' }];
      await storage.set('list', list);

      const value = await storage.get<number[]>('list');
      expect(value).toEqual(list);
    });

    it('get - 不存在的键返回 null', async () => {
      const value = await storage.get('nonexistent');
      expect(value).toBeNull();
    });

    it('remove - 删除数据', async () => {
      await storage.set('key', 'value');
      const removed = await storage.remove('key');
      expect(removed).toBe(true);

      const value = await storage.get('key');
      expect(value).toBeNull();
    });

    it('has - 检查键是否存在', async () => {
      await storage.set('key', 'value');
      expect(await storage.has('key')).toBe(true);
      expect(await storage.has('nonexistent')).toBe(false);
    });
  });

  describe('批量操作', () => {
    it('setItems/getKeys - 批量存储和获取', async () => {
      await storage.set('a', 1);
      await storage.set('b', 2);
      await storage.set('c', { x: 'y' });

      const values = await storage.getKeys(['a', 'b', 'c', 'd']);
      expect(values).toEqual({
        a: 1,
        b: 2,
        c: { x: 'y' },
        d: null,
      });
    });

    it('removeKeys - 批量删除', async () => {
      await storage.setItems([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
        { key: 'c', value: 3 },
      ]);

      await storage.removeKeys(['a', 'b']);

      const values = await storage.getKeys(['a', 'b', 'c']);
      expect(values).toEqual({
        a: null,
        b: null,
        c: 3,
      });
    });

    it('setItems - 返回结果顺序与输入顺序一致', async () => {
      const largeData = new Array(3 * 1024 * 1024).fill('o').join('');
      const results = await storage.setItems([
        { key: 'large', value: largeData },
        { key: 'small', value: 'hello' },
      ]);

      expect(results).toEqual([
        { success: true, source: 'IndexedDB' },
        { success: true, source: 'localStorage' },
      ]);
    });
  });

  describe('键名管理', () => {
    it('keys - 获取所有键名', async () => {
      await storage.setItems([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
        { key: 'c', value: 3 },
      ]);

      const keys = await storage.keys();
      expect(keys.sort()).toEqual(['a', 'b', 'c']);
    });

    it('keys - 只返回当前实例自己的 localStorage 键', async () => {
      const otherStorage = new LocalSmartStorage({ dbName: 'OtherDB', version: 1 });

      try {
        await storage.set('self', 1);
        await otherStorage.set('other', 2);
        localStorage.setItem('external', JSON.stringify('outside'));

        const keys = await storage.keys();
        expect(keys).toEqual(['self']);
      } finally {
        await otherStorage.clear();
        await otherStorage.close();
      }
    });

    it('clear - 清空所有数据', async () => {
      await storage.setItems([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
      ]);

      await storage.clear();

      const keys = await storage.keys();
      expect(keys).toHaveLength(0);
    });

    it('clear - 不清理实例之外的 localStorage 数据', async () => {
      const otherStorage = new LocalSmartStorage({ dbName: 'OtherDB', version: 1 });

      try {
        await storage.set('self', 1);
        await otherStorage.set('other', 2);
        localStorage.setItem('external', JSON.stringify('outside'));

        await storage.clear();

        expect(await storage.keys()).toEqual([]);
        expect(await otherStorage.get('other')).toBe(2);
        expect(localStorage.getItem('external')).toBe(JSON.stringify('outside'));
      } finally {
        localStorage.removeItem('external');
        await otherStorage.clear();
        await otherStorage.close();
      }
    });
  });

  describe('大数据自动降级', () => {
    it('同一 dbName 的多个实例会复用同一份 IndexedDB 连接', async () => {
      const openSpy = vi.spyOn(indexedDB, 'open');
      const storageA = new LocalSmartStorage({ dbName: 'SharedDB', version: 1, sizeThreshold: 10 });
      const storageB = new LocalSmartStorage({ dbName: 'SharedDB', version: 1, sizeThreshold: 10 });

      try {
        await storageA.set('a', 'hello world');
        await storageB.set('b', 'hello world');

        expect(openSpy).toHaveBeenCalledTimes(1);
      } finally {
        await storageA.clear();
        await storageA.close();
        await storageB.close();
      }
    });

    it('set - 支持通过配置对象自定义阈值', async () => {
      const customStorage = new LocalSmartStorage({
        dbName: 'ThresholdOptionsDB',
        version: 1,
        sizeThreshold: 10,
      });

      try {
        const result = await customStorage.set('value', 'hello world');

        expect(result.source).toBe('IndexedDB');
        expect(await customStorage.get('value')).toBe('hello world');
      } finally {
        await customStorage.clear();
        await customStorage.close();
      }
    });

    it('set - 大数据自动存入 IndexedDB', async () => {
      // 创建超过 2MB 的数据
      const largeData = new Array(3 * 1024 * 1024).fill('x').join('');
      const result = await storage.set('large', largeData);

      expect(result.success).toBe(true);
      expect(result.source).toBe('IndexedDB');

      // 仍然可以获取
      const value = await storage.get<string>('large');
      expect(value).toBe(largeData);
    });

    it('setItems - 批量大数据自动存入 IndexedDB', async () => {
      const largeData = new Array(3 * 1024 * 1024).fill('y').join('');
      const results = await storage.setItems([
        { key: 'small', value: 'hello' },
        { key: 'large', value: largeData },
      ]);

      expect(results[0].source).toBe('localStorage');
      expect(results[1].source).toBe('IndexedDB');
    });

    it('set - 支持通过构造参数自定义阈值', async () => {
      const customStorage = new LocalSmartStorage({
        dbName: 'ThresholdDB',
        version: 1,
        sizeThreshold: 10,
      });

      try {
        const result = await customStorage.set('value', 'hello world');

        expect(result.source).toBe('IndexedDB');
        expect(await customStorage.get('value')).toBe('hello world');
      } finally {
        await customStorage.clear();
        await customStorage.close();
      }
    });

    it('set - 同一个键从 localStorage 迁移到 IndexedDB 后读取最新值', async () => {
      await storage.set('profile', 'small');
      const largeData = new Array(3 * 1024 * 1024).fill('z').join('');

      const result = await storage.set('profile', largeData);

      expect(result.source).toBe('IndexedDB');
      expect(await storage.get('profile')).toBe(largeData);
      expect(localStorage.getItem('profile')).toBeNull();
    });

    it('set - 同一个键从 IndexedDB 迁移回 localStorage 时清理旧副本', async () => {
      const largeData = new Array(3 * 1024 * 1024).fill('w').join('');
      await storage.set('profile', largeData);

      const result = await storage.set('profile', 'small');

      expect(result.source).toBe('localStorage');
      expect(await storage.get('profile')).toBe('small');
      expect(await getRawIDBValue('TestDB', 'profile')).toBeNull();
    });
  });

  describe('数据类型支持', () => {
    it('set/get - 支持 null', async () => {
      await storage.set('null', null);
      const value = await storage.get('null');
      expect(value).toBeNull();
    });

    it('set/get - 支持布尔值', async () => {
      await storage.set('bool', true);
      const value = await storage.get<boolean>('bool');
      expect(value).toBe(true);
    });

    it('set/get - 支持数字', async () => {
      await storage.set('num', 42);
      const value = await storage.get<number>('num');
      expect(value).toBe(42);
    });

    it('set/get - 支持嵌套对象', async () => {
      const nested = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
              arr: [1, 2, { a: 'b' }],
            },
          },
        },
      };
      await storage.set('nested', nested);
      const value = await storage.get<typeof nested>('nested');
      expect(value).toEqual(nested);
    });
  });

  describe('并发和连接管理', () => {
    it('initDB - 并发调用返回同一个连接', async () => {
      // 多次调用 set 会并发触发 initDB
      const results = await Promise.all([
        storage.set('a', 1),
        storage.set('b', 2),
        storage.set('c', 3),
      ]);

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
    });

    it('close - 关闭后可以重新使用', async () => {
      await storage.set('key', 'value');
      await storage.close();

      // 关闭后再次使用
      await storage.set('key2', 'value2');
      const value = await storage.get('key2');
      expect(value).toBe('value2');
    });
  });

  describe('错误处理', () => {
    it('get - 损坏的 JSON 数据返回 null', async () => {
      // 手动写入损坏的数据
      localStorage.setItem('TestDB:corrupted', '{invalid json}');

      const value = await storage.get('corrupted');
      expect(value).toBeNull();

      // 损坏的数据应该被删除
      expect(localStorage.getItem('TestDB:corrupted')).toBeNull();
    });

    it('remove - 删除不存在的键不报错', async () => {
      const result = await storage.remove('nonexistent');
      expect(result).toBe(true);
    });

    it('set - 顶层 undefined 会抛出明确的序列化错误', async () => {
      const error = await storage.set('undefined', undefined).catch((reason) => reason);

      expect(error).toBeInstanceOf(StorageSerializationError);
      expect(error.name).toBe('StorageSerializationError');
      expect(error.message).toBe('Storage value must be JSON-serializable');
    });

    it('setItems - 循环引用会抛出明确的序列化错误', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const error = await storage
        .setItems([{ key: 'circular', value: circular }])
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(StorageSerializationError);
      expect(error.name).toBe('StorageSerializationError');
      expect(error.message).toBe('Storage value must be JSON-serializable');
    });

    it('set - 旧副本清理失败时仍保留成功的写入结果', async () => {
      await storage.set('profile', new Array(3 * 1024 * 1024).fill('p').join(''));
      const deleteFromIDB = (storage as unknown as { deleteFromIDB: (keys: string[]) => Promise<void> }).deleteFromIDB;
      (storage as unknown as { deleteFromIDB: () => Promise<void> }).deleteFromIDB = async () => {
        throw new Error('cleanup failed');
      };

      try {
        await expect(storage.set('profile', 'small')).resolves.toEqual({
          success: true,
          source: 'localStorage',
        });
        expect(await storage.get('profile')).toBe('small');
      } finally {
        (storage as unknown as { deleteFromIDB: (keys: string[]) => Promise<void> }).deleteFromIDB = deleteFromIDB;
      }
    });

    it('setItems - 旧副本批量清理失败时仍保留成功的写入结果', async () => {
      await storage.set('small', new Array(3 * 1024 * 1024).fill('q').join(''));
      const deleteFromIDB = (storage as unknown as { deleteFromIDB: (keys: string[]) => Promise<void> }).deleteFromIDB;
      (storage as unknown as { deleteFromIDB: () => Promise<void> }).deleteFromIDB = async () => {
        throw new Error('cleanup failed');
      };

      try {
        await expect(storage.setItems([{ key: 'small', value: 'value' }])).resolves.toEqual([
          { success: true, source: 'localStorage' },
        ]);
        expect(await storage.get('small')).toBe('value');
      } finally {
        (storage as unknown as { deleteFromIDB: (keys: string[]) => Promise<void> }).deleteFromIDB = deleteFromIDB;
      }
    });
  });
});
