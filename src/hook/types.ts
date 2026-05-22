import type { Ref, WatchStopHandle } from '@vue/reactivity';
import type { SerialExecQueue } from './SerialExecQueue';

/**
 * hook 依赖的最小存储协议。
 *
 * 这一层只关心三件事：
 * - 读取指定 key 的持久化值
 * - 写入最新的共享状态
 * - 删除指定 key 的持久化值
 *
 * 至于底层是 localStorage、IndexedDB，还是自定义存储实现，
 * 都由调用方自己决定。
 */
export type ReactiveStorageLike = {
  /** 读取指定 key；未命中时返回 null。 */
  get<T>(key: string): Promise<T | null>;
  /** 写入指定 key，对返回值没有额外约束。 */
  set<T>(key: string, value: T): Promise<unknown>;
  /** 删除指定 key；只要求调用方可以 await 完成。 */
  remove(key: string): Promise<boolean | void>;
};

type InitialValueFactory<T> = () => T;

/**
 * registry 中缓存的共享条目。
 *
 * 同一个 storage + key 只会存在一份条目，所有 hook 都复用它，
 * 这样多个消费者看到的是同一份响应式状态，而不是各自维护副本。
 *
 * 这些字段可以按职责分成 4 组：
 * - 共享状态本体：`state / isReady / error`
 * - 自动同步调度：`syncScheduled / syncInFlight / mutationVersion / hasPendingSync`
 * - 生命周期：`consumers / initializePromise / stopWatcher`
 * - 运行依赖：`storage / storageQueue / resolveInitialValue`
 */
export type SharedReactiveStorageEntry<T> = {
  /** 当前条目对应的业务 key。 */
  readonly key: string;
  /** 当前条目绑定的存储实例。 */
  readonly storage: ReactiveStorageLike;
  /** 对外暴露的共享响应式状态本体。 */
  readonly state: Ref<T>;
  /** 首次异步读取流程是否已经结束。 */
  readonly isReady: Ref<boolean>;
  /** 最近一次读写失败的错误；成功后会清空。 */
  readonly error: Ref<unknown | null>;
  /** 当前有多少 hook 正在消费这份共享条目，用于回收。 */
  consumers: number;
  /** 是否处于初始化、刷新或删除后的状态回填阶段。 */
  isHydrating: boolean;
  /** 是否已经安排过一次待执行的存储同步任务。 */
  syncScheduled: boolean;
  /** 当前是否存在进行中的异步存储同步。 */
  syncInFlight: boolean;
  /** 共享状态的逻辑变更版本号，用来合并重叠写入。 */
  mutationVersion: number;
  /** 当前是否存在尚未真正落盘的自动同步请求。 */
  hasPendingSync: boolean;
  /** 同一个共享条目的存储动作串行队列，避免命令式操作与自动同步互相打架。 */
  storageQueue: SerialExecQueue;
  /** 首次初始化读取任务，供后续消费者复用；命令式 refresh 不会覆写它。 */
  initializePromise: Promise<void> | null;
  /** 共享 watcher 的释放句柄；最后一个消费者离开时会清理。 */
  stopWatcher: WatchStopHandle | null;
  /** 生成默认值的工厂，用于首次初始化和 remove 后重置。 */
  resolveInitialValue: InitialValueFactory<T>;
};

/**
 * useReactiveStorage 的输入参数。
 */
export type UseReactiveStorageOptions<T> = {
  /** 当前响应式状态绑定的业务 key。 */
  key: string;
  /** 调用方传入的存储实例，只要满足最小协议即可。 */
  storage: ReactiveStorageLike;
  /** 默认值或默认值工厂；同一个 storage + key 只会在首次创建时采用。 */
  initialValue: T | (() => T);
};

/**
 * useReactiveStorage 的返回结构。
 */
export type UseReactiveStorageReturn<T> = {
  /** 供业务直接读写的共享响应式状态。 */
  state: Ref<T>;
  /** 首次异步读取是否已结束；通常建议在 true 后再执行依赖持久化状态的业务操作。 */
  isReady: Ref<boolean>;
  /** 最近一次读写失败的错误。 */
  error: Ref<unknown | null>;
  /** 命令式整值替换入口；会整体替换 state，并按串行顺序写入持久化层。 */
  set: (value: T) => Promise<void>;
  /** 删除持久化值，并把共享状态重置回默认值；会先撤销尚未开始的自动同步。 */
  remove: () => Promise<void>;
  /** 强制从持久化层重读，并按串行顺序覆盖当前共享状态。 */
  refresh: () => Promise<void>;
  /** 手动释放当前 hook 对共享条目的引用；无 effect scope 场景下建议显式调用。 */
  dispose: () => void;
};

/**
 * 默认 local/session hook 共用的输入参数。
 */
export type UseStorageHookOptions<T> = {
  /** 当前响应式状态绑定的业务 key。 */
  key: string;
  /** 默认值或默认值工厂。 */
  initialValue: T | (() => T);
};

/** useLocalStorage 的输入参数。 */
export type UseLocalStorageOptions<T> = UseStorageHookOptions<T>;

/** useSessionStorage 的输入参数。 */
export type UseSessionStorageOptions<T> = UseStorageHookOptions<T>;
