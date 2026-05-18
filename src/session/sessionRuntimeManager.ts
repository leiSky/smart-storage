import BaseSmartStorage from '../base/baseSmartStorage';
import { ResolvedSessionRuntimeOptions, SessionRecord } from '../types/internalTypes';
import { SessionSmartStorageOptions } from '../types/types';

interface SessionRuntimeState {
  options: ResolvedSessionRuntimeOptions;
  sessionId: string;
  sessionIdStorageKey: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  owners: Set<SessionRuntimeManager>;
  heartbeatOwner: SessionRuntimeCleanupOwner | null;
}

interface SessionRuntimeCleanupOwner {
  cleanupExpiredSessions(ttlMs?: number): Promise<number>;
}

interface SessionRuntimeManagerDependencies {
  options: ResolvedSessionRuntimeOptions;
  sessionStorage: Storage;
  initDB: () => Promise<IDBDatabase>;
  heartbeatOwner?: SessionRuntimeCleanupOwner;
  now?: () => number;
  sessionIdFactory?: () => string;
}

class SessionRuntimeManager {
  private static readonly DEFAULT_SESSION_TTL = 5 * 60 * 1000;
  private static readonly DEFAULT_HEARTBEAT_INTERVAL = 30 * 1000;
  private static readonly runtimes = new Map<string, SessionRuntimeState>();

  private readonly options: ResolvedSessionRuntimeOptions;
  private readonly sessionStorage: Storage;
  private readonly initDB: () => Promise<IDBDatabase>;
  private readonly heartbeatOwner: SessionRuntimeCleanupOwner;
  private readonly now: () => number;
  private readonly sessionIdFactory: () => string;
  private readonly sessionsStoreName = 'sessions';
  private readonly dataStoreName = 'sessionData';
  private readonly sessionIdStorageKeyValue: string;
  private readonly sessionIdValue: string;
  private runtimeKey: string | null = null;
  private runtimeReleased = false;

  static resolveOptions(
    options: SessionSmartStorageOptions = {},
  ): ResolvedSessionRuntimeOptions {
    const resolvedBaseOptions = BaseSmartStorage.resolveBaseOptions(options);

    return {
      ...resolvedBaseOptions,
      sessionTTL: options.sessionTTL ?? SessionRuntimeManager.DEFAULT_SESSION_TTL,
      heartbeatInterval: options.heartbeatInterval ?? SessionRuntimeManager.DEFAULT_HEARTBEAT_INTERVAL,
    };
  }

  private static hasSameOptions(
    left: ResolvedSessionRuntimeOptions,
    right: ResolvedSessionRuntimeOptions,
  ): boolean {
    return (
      left.dbName === right.dbName &&
      left.version === right.version &&
      left.sizeThreshold === right.sizeThreshold &&
      left.sessionTTL === right.sessionTTL &&
      left.heartbeatInterval === right.heartbeatInterval
    );
  }

  constructor({
    options,
    sessionStorage,
    initDB,
    heartbeatOwner,
    now = () => Date.now(),
    sessionIdFactory,
  }: SessionRuntimeManagerDependencies) {
    this.options = options;
    this.sessionStorage = sessionStorage;
    this.initDB = initDB;
    this.heartbeatOwner = heartbeatOwner ?? this;
    this.now = now;
    this.sessionIdFactory = sessionIdFactory ?? this.createSessionId;
    this.sessionIdStorageKeyValue = `${this.options.dbName}:session-id`;
    this.sessionIdValue = this.getOrCreateSessionId();
    this.attachRuntime();
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get sessionIdStorageKey(): string {
    return this.sessionIdStorageKeyValue;
  }

  get sessionTTL(): number {
    return this.options.sessionTTL;
  }

  async close(): Promise<void> {
    this.detachRuntime();
  }

  async touchSession(): Promise<void> {
    const db = await this.initDB();
    const now = this.now();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.sessionsStoreName], 'readwrite');
      const store = transaction.objectStore(this.sessionsStoreName);
      const request = store.get(this.sessionIdValue);

      request.onsuccess = () => {
        const existing = request.result as SessionRecord | undefined;
        store.put({
          sessionId: this.sessionIdValue,
          createdAt: existing?.createdAt ?? now,
          lastSeenAt: now,
        } satisfies SessionRecord);
      };

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async cleanupExpiredSessions(ttlMs = this.options.sessionTTL): Promise<number> {
    await this.touchSession();
    const db = await this.initDB();
    const cutoff = this.now() - ttlMs;

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.sessionsStoreName, this.dataStoreName], 'readwrite');
      const sessionsStore = transaction.objectStore(this.sessionsStoreName);
      const dataStore = transaction.objectStore(this.dataStoreName);
      const sessionIndex = dataStore.index('sessionId');
      const request = sessionsStore.getAll();
      let removed = 0;

      request.onsuccess = () => {
        const sessions = request.result as SessionRecord[];

        for (const session of sessions) {
          if (session.lastSeenAt <= cutoff) {
            removed += 1;
            sessionsStore.delete(session.sessionId);

            const cursorRequest = sessionIndex.openCursor(IDBKeyRange.only(session.sessionId));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (cursor) {
                cursor.delete();
                cursor.continue();
              }
            };
          }
        }
      };

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private createSessionId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `session-${Math.random().toString(36).slice(2)}`;
  };

  private getOrCreateSessionId(): string {
    const existing = this.sessionStorage.getItem(this.sessionIdStorageKeyValue);
    if (existing) {
      return existing;
    }

    const sessionId = this.sessionIdFactory();
    this.sessionStorage.setItem(this.sessionIdStorageKeyValue, sessionId);
    return sessionId;
  }

  private getRuntimeKey(): string {
    return `${this.options.dbName}:${this.sessionIdValue}`;
  }

  private attachRuntime(): void {
    const runtimeKey = this.getRuntimeKey();
    const existing = SessionRuntimeManager.runtimes.get(runtimeKey);

    if (existing) {
      if (!SessionRuntimeManager.hasSameOptions(existing.options, this.options)) {
        throw new Error(
          `SessionSmartStorage runtime for dbName "${this.options.dbName}" already exists with different options`,
        );
      }

      existing.owners.add(this);
      if (!existing.heartbeatOwner) {
        existing.heartbeatOwner = this.heartbeatOwner;
      }
      this.runtimeKey = runtimeKey;
      return;
    }

    const runtime: SessionRuntimeState = {
      options: this.options,
      sessionId: this.sessionIdValue,
      sessionIdStorageKey: this.sessionIdStorageKeyValue,
      heartbeatTimer: null,
      owners: new Set([this]),
      heartbeatOwner: this.heartbeatOwner,
    };

    if (this.options.heartbeatInterval > 0) {
      runtime.heartbeatTimer = setInterval(() => {
        void runtime.heartbeatOwner?.cleanupExpiredSessions(runtime.options.sessionTTL).catch(() => {});
      }, this.options.heartbeatInterval);
    }

    SessionRuntimeManager.runtimes.set(runtimeKey, runtime);
    this.runtimeKey = runtimeKey;
  }

  private detachRuntime(): void {
    if (!this.runtimeKey || this.runtimeReleased) {
      return;
    }

    this.runtimeReleased = true;
    const runtime = SessionRuntimeManager.runtimes.get(this.runtimeKey);

    if (!runtime) {
      this.runtimeKey = null;
      return;
    }

    runtime.owners.delete(this);

    if (runtime.owners.size === 0) {
      if (runtime.heartbeatTimer) {
        clearInterval(runtime.heartbeatTimer);
      }
      SessionRuntimeManager.runtimes.delete(this.runtimeKey);
      this.runtimeKey = null;
      return;
    }

    if (runtime.heartbeatOwner === this.heartbeatOwner) {
      runtime.heartbeatOwner = runtime.owners.values().next().value?.heartbeatOwner ?? null;
    }

    this.runtimeKey = null;
  }
}

export default SessionRuntimeManager;
