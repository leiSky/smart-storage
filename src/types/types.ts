interface BaseSmartStorageShape {
  dbName?: string;
  version?: number;
  sizeThreshold?: number;
}

export interface LocalSmartStorageOptions extends BaseSmartStorageShape {}

export interface SessionSmartStorageOptions extends BaseSmartStorageShape {
  sessionTTL?: number;
  heartbeatInterval?: number;
}

export type LocalStorageResult = {
  success: boolean;
  source: 'localStorage' | 'IndexedDB';
};

export type SessionStorageResult = {
  success: boolean;
  source: 'sessionStorage' | 'IndexedDB';
};

export interface StorageValueItem<T = unknown> {
  key: string;
  value: T;
}
