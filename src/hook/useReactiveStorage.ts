import { getCurrentScope, onScopeDispose } from '@vue/reactivity';
import {
  getOrCreateEntry,
  releaseEntry,
  retainEntry,
} from './sharedRegistry';
import type {
  SharedReactiveStorageEntry,
  UseReactiveStorageOptions,
  UseReactiveStorageReturn,
} from './types';

/**
 * 用统一入口替换共享状态，同时临时关闭自动回写。
 *
 * 这层主要服务命令式操作：
 * - `set()` 整体替换共享值
 * - `remove()` 删除后回退默认值
 *
 * 之所以要临时打开 `isHydrating`，是为了让共享 watcher 知道：
 * 这次变更是内部控制流触发的，不应该再额外安排一次自动持久化。
 */
const replaceState = <T>(entry: SharedReactiveStorageEntry<T>, value: T) => {
  // hydration 模式用于跳过初始化、刷新、删除重置时的自动回写，
  // 避免刚从存储读出来的数据又立刻被写回去。
  entry.isHydrating = true;
  entry.state.value = value;
  entry.isHydrating = false;
};

/**
 * 统一执行一次存储相关动作，并维护共享错误状态。
 *
 * 默认会把错误继续抛给调用方；像初始化回填这种只需要记录错误、
 * 不希望中断调用链的场景，可以显式关闭 rethrow。
 */
const runStorageAction = async (
  entry: SharedReactiveStorageEntry<unknown>,
  action: () => Promise<void>,
  options: { rethrow?: boolean } = {},
) => {
  const { rethrow = true } = options;

  try {
    await action();
    entry.error.value = null;
  } catch (error) {
    entry.error.value = error;

    if (rethrow) {
      throw error;
    }
  }
};

/**
 * 通过共享串行队列执行一次存储动作。
 *
 * 这里把“状态切换”和“底层存储读写”放进同一个排队任务里，
 * 避免内存状态先于前一个异步存储动作抢跑。
 */
const runQueuedStorageAction = async (
  entry: SharedReactiveStorageEntry<unknown>,
  action: () => Promise<void>,
  options: { rethrow?: boolean } = {},
) => {
  await entry.storageQueue.run(() => runStorageAction(entry, action, options));
};

/**
 * 读取存储值并覆盖当前共享状态本体。
 *
 * 这里只做“怎么把存储值映射回 state”，不负责：
 * - 错误记录
 * - 是否抛错
 * - 队列调度
 *
 * 这样初始化和 `refresh()` 可以复用同一段回填逻辑。
 */
const applyHydratedState = async <T>(entry: SharedReactiveStorageEntry<T>) => {
  const storedValue = await entry.storage.get<T>(entry.key);

  if (storedValue === null) {
    // 存储里没有值时，回退到共享默认值，
    // 但不会顺手把这个默认值隐式写回存储。
    entry.state.value = entry.resolveInitialValue();
  } else {
    entry.state.value = storedValue;
  }
};

/**
 * 从持久化层回填共享状态。
 *
 * 这里只负责状态回填本身：
 * - 命中值时用持久化值覆盖当前状态
 * - 未命中时回退到默认值
 * - 整个回填过程都不会触发自动写回
 *
 * 错误状态由外层入口决定：
 * - 初始化入口会吞错，只写 `error`
 * - `refresh()` 会抛错给调用方
 */
const hydrateEntry = async <T>(entry: SharedReactiveStorageEntry<T>) => {
  entry.isHydrating = true;

  try {
    await applyHydratedState(entry);
  } finally {
    entry.isHydrating = false;
    entry.isReady.value = true;
  }
};

/**
 * 确保首次初始化读取只发起一次，供同一共享条目的多个消费者复用。
 *
 * 这里的 `initializePromise` 只代表“首次初始化读取”；
 * 命令式 `refresh()` 不会覆写它。
 */
const ensureInitialized = <T>(entry: SharedReactiveStorageEntry<T>) => {
  if (!entry.initializePromise) {
    entry.initializePromise = runStorageAction(
      entry,
      () => hydrateEntry(entry),
      { rethrow: false },
    );
  }

  return entry.initializePromise;
};

export const useReactiveStorage = <T>(
  options: UseReactiveStorageOptions<T>,
): UseReactiveStorageReturn<T> => {
  // 同一个 storage + key 复用同一份共享条目，
  // 这样多个 hook 之间天然就是同一份响应式状态。
  const entry = getOrCreateEntry(options.storage, options.key, options.initialValue);
  retainEntry(entry);
  void ensureInitialized(entry);

  // 当前 hook 只对应“一个消费者引用”，不是整个共享条目本身。
  // `dispose()` 的职责是释放这个消费者；只有最后一个消费者离开时，
  // 共享 watcher 和 registry 记录才会真正回收。
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    releaseEntry(entry);
  };

  // 如果当前处在响应式作用域里，就在作用域销毁时释放共享引用。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      dispose();
    });
  }

  const set = async (value: T) => {
    // 命令式 set 需要和前面排队中的 remove/refresh 共用同一条串行链，
    // 避免内存状态抢跑，或后写入被前一条操作覆盖。
    await runQueuedStorageAction(entry, async () => {
      replaceState(entry, value);
      await entry.storage.set(entry.key, entry.state.value);
    });
  };

  const remove = async () => {
    // 删除是一个显式高优先级动作。
    // 这里先清掉“尚未真正开始执行”的自动 set，
    // 同步中的旧写入则交给串行队列自然排在前面跑完。
    //
    // 这两行故意放在 queue 外：
    // 它们是在真正执行 remove 之前，先撤销掉 watcher 已经标记、
    // 但还没来得及落盘的自动同步意图。
    entry.hasPendingSync = false;
    entry.mutationVersion += 1;

    await runQueuedStorageAction(entry, async () => {
      await entry.storage.remove(entry.key);
      replaceState(entry, entry.resolveInitialValue());
    });
  };

  const refresh = async () => {
    // refresh 也要遵守同一条串行执行链，
    // 避免和前面排队中的 set/remove 交叉覆盖。
    //
    // 这里不会覆写 `initializePromise`，因为它只表示首次初始化阶段。
    await runQueuedStorageAction(entry, () => hydrateEntry(entry));
  };

  return {
    state: entry.state,
    isReady: entry.isReady,
    error: entry.error,
    set,
    remove,
    refresh,
    dispose,
  };
};
