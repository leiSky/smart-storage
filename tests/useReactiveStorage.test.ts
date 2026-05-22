import { effectScope } from '@vue/reactivity';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReactiveStorage } from '../src/hook/index.ts';
import {
  LocalSmartStorage,
  SessionSmartStorage,
  useLocalStorage,
  useSessionStorage,
} from '../src/index.ts';

type StorageCall<T = unknown> = {
  key: string;
  value: T;
};

type TestStorage = {
  calls: {
    get: string[];
    set: StorageCall[];
    remove: string[];
  };
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  seed(key: string, value: unknown): void;
  read<T>(key: string): T | null;
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const deleteDatabase = async (dbName: string) => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
};

const cloneValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const createTestStorage = (options: {
  initialValues?: Record<string, unknown>;
  failGet?: boolean;
  failSet?: boolean;
} = {}): TestStorage => {
  const values = new Map<string, unknown>(Object.entries(options.initialValues ?? {}));

  return {
    calls: {
      get: [],
      set: [],
      remove: [],
    },
    async get<T>(key: string): Promise<T | null> {
      this.calls.get.push(key);

      if (options.failGet) {
        throw new Error('get failed');
      }

      if (!values.has(key)) {
        return null;
      }

      return cloneValue(values.get(key) as T);
    },
    async set<T>(key: string, value: T): Promise<void> {
      this.calls.set.push({ key, value: cloneValue(value) });

      if (options.failSet) {
        throw new Error('set failed');
      }

      values.set(key, cloneValue(value));
    },
    async remove(key: string): Promise<void> {
      this.calls.remove.push(key);
      values.delete(key);
    },
    seed(key: string, value: unknown) {
      values.set(key, cloneValue(value));
    },
    read<T>(key: string): T | null {
      if (!values.has(key)) {
        return null;
      }

      return cloneValue(values.get(key) as T);
    },
  };
};

const scopes: Array<{ stop(): void }> = [];

const runHook = <T>(factory: () => T): T => {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(factory) as T;
};

const mountReactiveStorageHook = <T>(
  storage: {
    get<TValue>(key: string): Promise<TValue | null>;
    set<TValue>(key: string, value: TValue): Promise<void>;
    remove(key: string): Promise<void>;
  },
  key: string,
  initialValue: T | (() => T),
) => runHook(() =>
  useReactiveStorage({
    key,
    storage,
    initialValue,
  }),
);

const mountLocalStorageHook = <T>(key: string, initialValue: T | (() => T)) => runHook(() =>
  useLocalStorage({
    key,
    initialValue,
  }),
);

const mountSessionStorageHook = <T>(key: string, initialValue: T | (() => T)) => runHook(() =>
  useSessionStorage({
    key,
    initialValue,
  }),
);

afterEach(() => {
  while (scopes.length > 0) {
    scopes.pop()?.stop();
  }
});

describe('useReactiveStorage', () => {
  it('reuses the same state for the same storage and key', async () => {
    const storage = createTestStorage({
      initialValues: {
        profile: { name: 'persisted', age: 18 },
      },
    });

    const hookA = mountReactiveStorageHook(storage, 'profile', () => ({ name: 'default', age: 0 }));
    const hookB = mountReactiveStorageHook(storage, 'profile', () => ({ name: 'ignored', age: 99 }));

    expect(hookA.state).toBe(hookB.state);
    expect(hookA.isReady.value).toBe(false);
    expect(hookA.state.value).toEqual({ name: 'default', age: 0 });

    await flushPromises();

    expect(storage.calls.get).toEqual(['profile']);
    expect(hookA.isReady.value).toBe(true);
    expect(hookA.state.value).toEqual({ name: 'persisted', age: 18 });
    expect(hookB.state.value).toEqual({ name: 'persisted', age: 18 });
  });

  it('persists mutations and keeps shared consumers in sync', async () => {
    const storage = createTestStorage();
    const hookA = mountReactiveStorageHook(storage, 'draft', () => ({ title: '', done: false }));
    const hookB = mountReactiveStorageHook(storage, 'draft', () => ({ title: 'ignored', done: true }));

    await flushPromises();

    hookA.state.value.title = 'hello';
    hookA.state.value.done = true;

    await flushPromises();

    expect(hookB.state.value).toEqual({ title: 'hello', done: true });
    expect(storage.calls.set).toEqual([
      {
        key: 'draft',
        value: { title: 'hello', done: true },
      },
    ]);
    expect(storage.read('draft')).toEqual({ title: 'hello', done: true });
  });

  it('remove clears storage and resets shared state to the initial value', async () => {
    const storage = createTestStorage({
      initialValues: {
        draft: { title: 'persisted', done: true },
      },
    });
    const hook = mountReactiveStorageHook(storage, 'draft', () => ({ title: '', done: false }));

    await flushPromises();
    await hook.remove();
    await flushPromises();

    expect(storage.calls.remove).toEqual(['draft']);
    expect(storage.calls.set).toEqual([]);
    expect(storage.read('draft')).toBeNull();
    expect(hook.state.value).toEqual({ title: '', done: false });
  });

  it('refresh replaces the current state with the latest persisted value', async () => {
    const storage = createTestStorage({
      initialValues: {
        settings: { theme: 'light' },
      },
    });
    const hook = mountReactiveStorageHook(storage, 'settings', () => ({ theme: 'system' }));

    await flushPromises();
    storage.seed('settings', { theme: 'dark' });

    await hook.refresh();

    expect(hook.state.value).toEqual({ theme: 'dark' });
  });

  it('runs refresh after queued writes in call order', async () => {
    let resolveSet: (() => void) | null = null;
    const storageValue = new Map<string, unknown>([
      ['draft', { title: 'persisted' }],
    ]);
    const callOrder: string[] = [];
    const storage = {
      async get<T>(key: string): Promise<T | null> {
        callOrder.push('get');
        return (storageValue.get(key) as T | undefined) ?? null;
      },
      async set<T>(key: string, value: T): Promise<void> {
        callOrder.push('set:start');

        await new Promise<void>((resolve) => {
          resolveSet = resolve;
        });

        callOrder.push('set:finish');
        storageValue.set(key, cloneValue(value));
      },
      async remove(): Promise<void> {
        return;
      },
    };

    const hook = mountReactiveStorageHook(storage, 'draft', () => ({ title: '' }));

    await flushPromises();

    const setPromise = hook.set({ title: 'queued-write' });
    await flushPromises();

    const refreshPromise = hook.refresh();
    await flushPromises();

    resolveSet?.();
    await setPromise;
    await refreshPromise;

    expect(callOrder).toEqual(['get', 'set:start', 'set:finish', 'get']);
    expect(hook.state.value).toEqual({ title: 'queued-write' });
    expect(storageValue.get('draft')).toEqual({ title: 'queued-write' });
  });

  it('keeps same-key state isolated across storage instances', async () => {
    const storageA = createTestStorage({
      initialValues: {
        profile: { name: 'A' },
      },
    });
    const storageB = createTestStorage({
      initialValues: {
        profile: { name: 'B' },
      },
    });
    const hookA = mountReactiveStorageHook(storageA, 'profile', () => ({ name: 'default-a' }));
    const hookB = mountReactiveStorageHook(storageB, 'profile', () => ({ name: 'default-b' }));

    await flushPromises();

    hookA.state.value.name = 'updated-a';
    await flushPromises();

    expect(hookA.state.value).toEqual({ name: 'updated-a' });
    expect(hookB.state.value).toEqual({ name: 'B' });
    expect(storageA.read('profile')).toEqual({ name: 'updated-a' });
    expect(storageB.read('profile')).toEqual({ name: 'B' });
  });

  it('captures initialization errors without replacing the in-memory state', async () => {
    const storage = createTestStorage({ failGet: true });
    const hook = mountReactiveStorageHook(storage, 'draft', () => ({ title: 'local' }));

    await flushPromises();

    expect(hook.isReady.value).toBe(true);
    expect(hook.state.value).toEqual({ title: 'local' });
    expect(hook.error.value).toBeInstanceOf(Error);
    expect((hook.error.value as Error).message).toBe('get failed');
  });

  it('keeps the latest in-memory state when persistence fails', async () => {
    const storage = createTestStorage({ failSet: true });
    const hook = mountReactiveStorageHook(storage, 'draft', () => ({ title: '' }));

    await flushPromises();

    hook.state.value.title = 'local-change';
    await flushPromises();

    expect(hook.state.value).toEqual({ title: 'local-change' });
    expect(hook.error.value).toBeInstanceOf(Error);
    expect((hook.error.value as Error).message).toBe('set failed');
    expect(storage.read('draft')).toBeNull();
  });

  it('records command set failures on error state', async () => {
    const storage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error('command set failed');
      },
      async remove() {
        return;
      },
    };
    const hook = mountReactiveStorageHook(storage, 'draft', () => ({ title: '' }));

    await flushPromises();

    await expect(hook.set({ title: 'next' })).rejects.toThrow('command set failed');
    expect(hook.error.value).toBeInstanceOf(Error);
    expect((hook.error.value as Error).message).toBe('command set failed');
  });

  it('records command remove failures on error state', async () => {
    const storage = {
      async get() {
        return null;
      },
      async set() {
        return;
      },
      async remove() {
        throw new Error('command remove failed');
      },
    };
    const hook = mountReactiveStorageHook(storage, 'draft', () => ({ title: '' }));

    await flushPromises();

    await expect(hook.remove()).rejects.toThrow('command remove failed');
    expect(hook.error.value).toBeInstanceOf(Error);
    expect((hook.error.value as Error).message).toBe('command remove failed');
  });

  it('runs storage write and remove actions serially for the same shared entry', async () => {
    let resolveSet: (() => void) | null = null;
    const storageValue = new Map<string, unknown>();
    const callOrder: string[] = [];
    const storage = {
      async get<T>(key: string): Promise<T | null> {
        return (storageValue.get(key) as T | undefined) ?? null;
      },
      async set<T>(key: string, value: T): Promise<void> {
        callOrder.push('set:start');

        await new Promise<void>((resolve) => {
          resolveSet = resolve;
        });

        callOrder.push('set:finish');
        storageValue.set(key, cloneValue(value));
      },
      async remove(key: string): Promise<void> {
        callOrder.push('remove');
        storageValue.delete(key);
      },
    };

    const hook = runHook(() =>
      useReactiveStorage({
        key: 'draft',
        storage,
        initialValue: () => ({ title: '' }),
      }),
    );

    await flushPromises();

    hook.state.value.title = 'pending-write';
    await flushPromises();

    const removePromise = hook.remove();
    await flushPromises();

    expect(callOrder).toEqual(['set:start']);

    resolveSet?.();
    await removePromise;

    expect(callOrder).toEqual(['set:start', 'set:finish', 'remove']);
    expect(storageValue.has('draft')).toBe(false);
  });

  it('applies set after a queued remove in call order', async () => {
    let resolveRemove: (() => void) | null = null;
    const storageValue = new Map<string, unknown>([
      ['draft', { title: 'persisted' }],
    ]);
    const callOrder: string[] = [];
    const storage = {
      async get<T>(key: string): Promise<T | null> {
        return (storageValue.get(key) as T | undefined) ?? null;
      },
      async set<T>(key: string, value: T): Promise<void> {
        callOrder.push('set');
        storageValue.set(key, cloneValue(value));
      },
      async remove(key: string): Promise<void> {
        callOrder.push('remove:start');

        await new Promise<void>((resolve) => {
          resolveRemove = resolve;
        });

        callOrder.push('remove:finish');
        storageValue.delete(key);
      },
    };

    const hook = runHook(() =>
      useReactiveStorage({
        key: 'draft',
        storage,
        initialValue: () => ({ title: '' }),
      }),
    );

    await flushPromises();

    const removePromise = hook.remove();
    await flushPromises();

    const setPromise = hook.set({ title: 'after-remove' });

    expect(hook.state.value).toEqual({ title: 'persisted' });

    resolveRemove?.();
    await removePromise;
    await setPromise;

    expect(callOrder).toEqual(['remove:start', 'remove:finish', 'set']);
    expect(hook.state.value).toEqual({ title: 'after-remove' });
    expect(storageValue.get('draft')).toEqual({ title: 'after-remove' });
  });

  it('supports manual dispose when used outside an effect scope', async () => {
    const storage = createTestStorage({
      initialValues: {
        draft: { title: 'persisted' },
      },
    });

    const firstHook = useReactiveStorage({
      key: 'draft',
      storage,
      initialValue: () => ({ title: 'first' }),
    });

    await flushPromises();
    firstHook.dispose();

    const secondHook = useReactiveStorage({
      key: 'draft',
      storage,
      initialValue: () => ({ title: 'second' }),
    });

    await flushPromises();

    expect(storage.calls.get).toEqual(['draft', 'draft']);
    expect(firstHook.state).not.toBe(secondHook.state);
    expect(secondHook.state.value).toEqual({ title: 'persisted' });

    secondHook.dispose();
  });

  it('releases the shared entry after the last consumer scope stops', async () => {
    const storage = createTestStorage();
    const firstScope = effectScope();
    scopes.push(firstScope);

    const firstHook = firstScope.run(() =>
      useReactiveStorage({
        key: 'draft',
        storage,
        initialValue: () => ({ title: 'first' }),
      }),
    ) as { state: { value: { title: string } } };

    await flushPromises();
    firstScope.stop();

    const secondHook = mountReactiveStorageHook(storage, 'draft', () => ({ title: 'second' }));

    await flushPromises();

    expect(storage.calls.get).toEqual(['draft', 'draft']);
    expect(firstHook.state).not.toBe(secondHook.state);
    expect(secondHook.state.value).toEqual({ title: 'second' });
  });

  it('exports a local-storage-based hook that shares state with the default storage', async () => {
    localStorage.clear();

    const hookA = mountLocalStorageHook('profile', () => ({ name: 'default' }));
    const hookB = mountLocalStorageHook('profile', () => ({ name: 'ignored' }));

    await flushPromises();

    hookA.state.value.name = 'shared-local';
    await flushPromises();

    expect(hookA.state).toBe(hookB.state);
    expect(hookB.state.value).toEqual({ name: 'shared-local' });
  });

  it('keeps the default local hook isolated from a manually created default LocalSmartStorage', async () => {
    localStorage.clear();
    const directStorage = new LocalSmartStorage();

    try {
      await directStorage.set('profile', { name: 'direct-local' });

      const hook = mountLocalStorageHook('profile', () => ({ name: 'hook-local' }));

      await flushPromises();

      expect(hook.state.value).toEqual({ name: 'hook-local' });
    } finally {
      await directStorage.clear();
      await directStorage.close();
      await deleteDatabase('SmartStorage');
    }
  });

  it('exports a session-storage-based hook that shares state with the default storage', async () => {
    sessionStorage.clear();

    const hookA = mountSessionStorageHook('draft', () => ({ title: '' }));
    const hookB = mountSessionStorageHook('draft', () => ({ title: 'ignored' }));

    await flushPromises();

    hookA.state.value.title = 'shared-session';
    await flushPromises();

    expect(hookA.state).toBe(hookB.state);
    expect(hookB.state.value).toEqual({ title: 'shared-session' });
  });

  it('keeps the default session hook isolated from a manually created default SessionSmartStorage', async () => {
    sessionStorage.clear();
    const directStorage = new SessionSmartStorage({ heartbeatInterval: 0 });

    try {
      await directStorage.set('draft', { title: 'direct-session' });

      const hook = mountSessionStorageHook('draft', () => ({ title: 'hook-session' }));

      await flushPromises();

      expect(hook.state.value).toEqual({ title: 'hook-session' });
    } finally {
      await directStorage.clear();
      await directStorage.close();
      await deleteDatabase('SmartStorage');
    }
  });

  it('can import storage hooks without eagerly touching browser storage globals', async () => {
    const originalLocalStorage = globalThis.localStorage;
    const originalSessionStorage = globalThis.sessionStorage;

    vi.resetModules();
    Reflect.deleteProperty(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'sessionStorage');

    try {
      await expect(import('../src/hook/storageHooks.ts?lazy-test')).resolves.toBeTruthy();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: originalSessionStorage,
      });
    }
  });
});
