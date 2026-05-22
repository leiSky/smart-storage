import { ref, watch, type Ref } from '@vue/reactivity';
import { SerialExecQueue } from './SerialExecQueue';
import type {
  ReactiveStorageLike,
  SharedReactiveStorageEntry,
} from './types';

type InitialValueFactory<T> = () => T;

/**
 * 按 storage 实例分组，再按业务 key 缓存共享条目。
 *
 * 共享粒度是：
 * - 同一个 storage 实例
 * - 同一个 key
 *
 * 满足这两个条件的 hook 会拿到同一份响应式状态。
 */
const registry = new WeakMap<ReactiveStorageLike, Map<string, SharedReactiveStorageEntry<unknown>>>();

const cloneValue = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
};

const createInitialValueFactory = <T>(initialValue: T | (() => T)): InitialValueFactory<T> => {
  if (typeof initialValue === 'function') {
    return () => cloneValue((initialValue as () => T)());
  }

  return () => cloneValue(initialValue);
};

/**
 * 安排一次自动持久化调度。
 *
 * 这里先用 microtask 合并同一轮里的多次同步改动，
 * 再交给 `syncEntryToStorage()` 统一落盘。
 */
const queueStorageSync = <T>(entry: SharedReactiveStorageEntry<T>) => {
  if (entry.syncScheduled || entry.syncInFlight || !entry.hasPendingSync) {
    return;
  }

  entry.syncScheduled = true;

  queueMicrotask(() => {
    entry.syncScheduled = false;
    void syncEntryToStorage(entry);
  });
};

/**
 * 标记共享状态存在新的自动同步需求。
 *
 * watcher 每次捕获到业务侧对 `state` 的改动时，只做两件事：
 * - 记录“现在有待同步改动”
 * - 递增变更版本号
 *
 * 真正的写存储动作会延后到微任务和串行队列里统一执行。
 */
const markStorageSync = <T>(entry: SharedReactiveStorageEntry<T>) => {
  // 记录共享状态的逻辑变更次数。
  // 这样当异步同步重叠时，旧动作结束后还能补一次最新动作。
  entry.hasPendingSync = true;
  entry.mutationVersion += 1;
  queueStorageSync(entry);
};

/**
 * 把当前共享状态落到持久化层。
 *
 * 这里故意不做回滚：页面内存状态是事实来源，
 * 存储只是它的持久化副本。
 *
 * 这条链只处理 watcher 触发的“自动同步”。
 * 命令式 `set/remove/refresh` 会直接走 `useReactiveStorage.ts`
 * 里的串行入口，不依赖这里的调度状态。
 */
const syncEntryToStorage = async <T>(entry: SharedReactiveStorageEntry<T>) => {
  if (!entry.hasPendingSync) {
    return;
  }

  entry.syncInFlight = true;
  const versionToSync = entry.mutationVersion;

  // 一旦开始真正执行本轮同步，就先清掉 pending 标记。
  // 如果同步过程中 state 又变了，watcher 会重新把它标成 true，
  // 最后通过版本号判断是否需要再补一轮同步。
  entry.hasPendingSync = false;

  try {
    await entry.storageQueue.run(() => entry.storage.set(entry.key, entry.state.value));
    entry.error.value = null;
  } catch (error) {
    entry.error.value = error;
  } finally {
    entry.syncInFlight = false;

    // 如果同步期间又来了新的动作，就再补一次同步，
    // 但只补当前最新动作，避免重复执行旧快照。
    if (entry.mutationVersion > versionToSync) {
      queueStorageSync(entry);
    }
  }
};

const createEntry = <T>(
  storage: ReactiveStorageLike,
  key: string,
  initialValue: T | (() => T),
): SharedReactiveStorageEntry<T> => {
  const resolveInitialValue = createInitialValueFactory(initialValue);

  // 同一个共享条目里只保留一份状态和一份 watcher。
  // 多个 hook 消费同一个条目时，复用的是这整份结构。
  const entry: SharedReactiveStorageEntry<T> = {
    key,
    storage,
    state: ref(resolveInitialValue()) as Ref<T>,
    isReady: ref(false),
    error: ref<unknown | null>(null),
    consumers: 0,
    isHydrating: false,
    syncScheduled: false,
    syncInFlight: false,
    mutationVersion: 0,
    hasPendingSync: false,
    storageQueue: new SerialExecQueue(),
    initializePromise: null,
    stopWatcher: null,
    resolveInitialValue,
  };

  // 同一个 storage + key 只保留一个共享 watcher。
  // 这样多个 hook 复用同一份状态时，不会随着订阅者增加而重复写入存储。
  entry.stopWatcher = watch(entry.state, () => {
    if (entry.isHydrating) {
      return;
    }

    markStorageSync(entry);
  }, { deep: true });

  return entry;
};

export const getOrCreateEntry = <T>(
  storage: ReactiveStorageLike,
  key: string,
  initialValue: T | (() => T),
): SharedReactiveStorageEntry<T> => {
  let storageEntries = registry.get(storage);
  if (!storageEntries) {
    storageEntries = new Map<string, SharedReactiveStorageEntry<unknown>>();
    registry.set(storage, storageEntries);
  }

  const existing = storageEntries.get(key);
  if (existing) {
    // 后续同 key 的 hook 会直接复用首次创建的共享条目，
    // 包括其中的 state、错误状态、初始化任务和 watcher。
    return existing as SharedReactiveStorageEntry<T>;
  }

  const entry = createEntry(storage, key, initialValue);
  storageEntries.set(key, entry as SharedReactiveStorageEntry<unknown>);
  return entry;
};

/** 增加共享条目的消费者计数。 */
export const retainEntry = (entry: SharedReactiveStorageEntry<unknown>) => {
  entry.consumers += 1;
};

/**
 * 释放一个消费者；若已无人使用，则销毁共享 watcher 并移除缓存。
 *
 * 这里释放的是“当前 hook 对共享条目的引用”，不是强制销毁整个系统里的
 * 所有相关状态。只有最后一个消费者离开时，条目才会真正回收。
 */
export const releaseEntry = (entry: SharedReactiveStorageEntry<unknown>) => {
  entry.consumers -= 1;

  if (entry.consumers > 0) {
    return;
  }

  // 共享条目只由活跃消费者持有；
  // 最后一个消费者离开后，就可以释放 watcher 并移除 registry 记录。
  entry.stopWatcher?.();
  entry.stopWatcher = null;

  const storageEntries = registry.get(entry.storage);
  if (!storageEntries) {
    return;
  }

  storageEntries.delete(entry.key);
};
