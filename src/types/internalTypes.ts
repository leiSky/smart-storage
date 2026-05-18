import type { StorageValueItem } from './types';

export interface BaseSmartStorageOptions {
  dbName?: string;
  version?: number;
  sizeThreshold?: number;
  storageArea?: Storage;
}

export interface ResolvedBaseSmartStorageOptions {
  dbName: string;
  version: number;
  sizeThreshold: number;
}

export interface SharedDbEntry {
  ownerCount: number;
  promise: Promise<IDBDatabase> | null;
}

export interface ResolvedSessionRuntimeOptions extends ResolvedBaseSmartStorageOptions {
  sessionTTL: number;
  heartbeatInterval: number;
}

export interface SessionRecord {
  sessionId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionDataItem<T = unknown> extends StorageValueItem<T> {
  compoundKey: string;
  sessionId: string;
}
