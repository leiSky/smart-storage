import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import SessionSmartStorage from '../src/session/sessionSmartStorage.ts';

describe('SessionSmartStorage', () => {
  let dbName: string;
  let currentTime: number;
  let storages: SessionSmartStorage[] = [];

  const createSessionStorage = () => {
    const { window } = new JSDOM('', { url: 'http://localhost' });
    return window.sessionStorage;
  };

  const createStorage = (storageArea: Storage, sessionId: string, sizeThreshold = 1024) => {
    vi.stubGlobal('sessionStorage', storageArea);
    const randomUUIDSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(sessionId);
    const storage = new SessionSmartStorage({
      dbName,
      sizeThreshold,
      sessionTTL: 100,
      heartbeatInterval: 0,
    });
    randomUUIDSpy.mockRestore();

    storages.push(storage);
    return storage;
  };

  beforeEach(() => {
    dbName = `SessionTestDB-${Math.random().toString(36).slice(2)}`;
    currentTime = 0;
    storages = [];
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  afterEach(async () => {
    await Promise.all(storages.map(async (storage) => storage.close()));
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database deletion blocked'));
    });
  });

  it('constructor - 同一会话里重复 new 会复用同一份会话资源', async () => {
    const storageArea = createSessionStorage();
    vi.stubGlobal('sessionStorage', storageArea);
    const randomUUIDSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('session-a');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const storageA = new SessionSmartStorage({
      dbName,
      sessionTTL: 100,
      heartbeatInterval: 0,
    });
    const storageB = new SessionSmartStorage({
      dbName,
      sessionTTL: 100,
      heartbeatInterval: 0,
    });

    randomUUIDSpy.mockRestore();
    storages.push(storageA, storageB);

    await storageA.set('draft', 'hello');
    expect(await storageB.get('draft')).toBe('hello');
    expect(storageArea.getItem(`${dbName}:session-id`)).toBe('session-a');
    expect(setIntervalSpy).toHaveBeenCalledTimes(0);
  });

  it('constructor - 同一会话使用不同配置时抛出明确错误', () => {
    const storageArea = createSessionStorage();
    vi.stubGlobal('sessionStorage', storageArea);
    const randomUUIDSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('session-a');

    const storage = new SessionSmartStorage({
      dbName,
      sessionTTL: 100,
      heartbeatInterval: 0,
    });

    randomUUIDSpy.mockRestore();
    storages.push(storage);

    expect(() =>
      new SessionSmartStorage({
        dbName,
        sessionTTL: 200,
        heartbeatInterval: 0,
      }),
    ).toThrowError(`SessionSmartStorage runtime for dbName "${dbName}" already exists with different options`);
  });

  it('constructor - 同一会话重复创建实例时只启动一份心跳', async () => {
    const storageArea = createSessionStorage();
    vi.stubGlobal('sessionStorage', storageArea);
    const randomUUIDSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('session-a');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const storageA = new SessionSmartStorage({
      dbName,
      heartbeatInterval: 1000,
    });
    const storageB = new SessionSmartStorage({
      dbName,
      heartbeatInterval: 1000,
    });

    randomUUIDSpy.mockRestore();
    storages.push(storageA, storageB);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('close - 当前心跳 owner 关闭后会移交给剩余实例', async () => {
    const storageArea = createSessionStorage();
    vi.stubGlobal('sessionStorage', storageArea);
    const randomUUIDSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('session-a');

    let heartbeatCallback: (() => void) | null = null;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((callback: TimerHandler) => {
        heartbeatCallback = callback as () => void;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    const storageA = new SessionSmartStorage({
      dbName,
      heartbeatInterval: 1000,
      sessionTTL: 100,
    });
    const storageB = new SessionSmartStorage({
      dbName,
      heartbeatInterval: 1000,
      sessionTTL: 100,
    });

    randomUUIDSpy.mockRestore();
    storages.push(storageA, storageB);

    const cleanupASpy = vi.spyOn(storageA, 'cleanupExpiredSessions');
    const originalCleanupB = storageB.cleanupExpiredSessions.bind(storageB);
    let cleanupPromise: Promise<number> | undefined;
    const cleanupBSpy = vi.spyOn(storageB, 'cleanupExpiredSessions').mockImplementation((ttlMs?: number) => {
      cleanupPromise = originalCleanupB(ttlMs);
      return cleanupPromise;
    });

    await storageA.close();
    heartbeatCallback?.();
    await cleanupPromise;

    expect(cleanupASpy).not.toHaveBeenCalled();
    expect(cleanupBSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });

  it('set/get - 小数据保存在 sessionStorage', async () => {
    const storageArea = createSessionStorage();
    const storage = createStorage(storageArea, 'session-a');

    const result = await storage.set('draft', { title: 'hello' });

    expect(result).toEqual({ success: true, source: 'sessionStorage' });
    expect(storageArea.getItem(`${dbName}:draft`)).toBe(JSON.stringify({ title: 'hello' }));
    expect(await storage.get('draft')).toEqual({ title: 'hello' });
  });

  it('keys/clear - 不暴露也不删除内部 sessionId key', async () => {
    const storageArea = createSessionStorage();
    const storage = createStorage(storageArea, 'session-a');

    await storage.set('draft', 'hello');

    expect(await storage.keys()).toEqual(['draft']);
    expect(storageArea.getItem(`${dbName}:session-id`)).toBe('session-a');

    await storage.clear();

    expect(storageArea.getItem(`${dbName}:session-id`)).toBe('session-a');
    expect(await storage.keys()).toEqual([]);
  });

  it('构造函数 - 使用配置对象覆盖公共参数和会话参数', async () => {
    const storageArea = createSessionStorage();
    vi.stubGlobal('sessionStorage', storageArea);
    const randomUUIDSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('session-a');
    const storage = new SessionSmartStorage({
      dbName,
      version: 1,
      sizeThreshold: 10,
      sessionTTL: 100,
      heartbeatInterval: 0,
    });
    randomUUIDSpy.mockRestore();

    storages.push(storage);

    const result = await storage.set('draft', 'hello world');

    expect(result).toEqual({ success: true, source: 'IndexedDB' });
    expect(await storage.get('draft')).toBe('hello world');
  });

  it('set/get - 大数据自动降级到 IndexedDB', async () => {
    const storageArea = createSessionStorage();
    const storage = createStorage(storageArea, 'session-a', 10);

    const result = await storage.set('draft', 'hello world');

    expect(result).toEqual({ success: true, source: 'IndexedDB' });
    expect(storageArea.getItem(`${dbName}:draft`)).toBeNull();
    expect(await storage.get('draft')).toBe('hello world');
  });

  it('多会话之间的 IndexedDB 数据互相隔离', async () => {
    const storageA = createStorage(createSessionStorage(), 'session-a', 10);
    const storageB = createStorage(createSessionStorage(), 'session-b', 10);

    await storageA.set('draft', 'hello world');

    expect(await storageA.get('draft')).toBe('hello world');
    expect(await storageB.get('draft')).toBeNull();
  });

  it('cleanupExpiredSessions - 只清理超时未续租的会话数据', async () => {
    const storageA = createStorage(createSessionStorage(), 'session-a', 10);
    const storageB = createStorage(createSessionStorage(), 'session-b', 10);

    await storageA.set('stale', 'hello world');
    await storageB.set('fresh', 'keep me');

    currentTime = 50;
    await storageB.get('fresh');

    currentTime = 120;
    const removed = await storageB.cleanupExpiredSessions();

    expect(removed).toBe(1);
    expect(await storageA.get('stale')).toBeNull();
    expect(await storageB.get('fresh')).toBe('keep me');
  });
});
