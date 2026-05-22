import LocalSmartStorage from '../local/localSmartStorage';
import SessionSmartStorage from '../session/sessionSmartStorage';
import {
  useReactiveStorage,
} from './useReactiveStorage';
import type {
  UseLocalStorageOptions,
  UseReactiveStorageReturn,
  UseSessionStorageOptions,
} from './types';

let defaultLocalStorage: LocalSmartStorage | null = null;
let defaultSessionStorage: SessionSmartStorage | null = null;

const getDefaultLocalStorage = () => {
  if (!defaultLocalStorage) {
    defaultLocalStorage = new LocalSmartStorage({
      dbName: 'SmartStorageHookLocal',
    });
  }

  return defaultLocalStorage;
};

const getDefaultSessionStorage = () => {
  if (!defaultSessionStorage) {
    defaultSessionStorage = new SessionSmartStorage({
      dbName: 'SmartStorageHookSession',
    });
  }

  return defaultSessionStorage;
};

/**
 * 使用 LocalSmartStorage 作为默认持久化实现的响应式 hook。
 */
export const useLocalStorage = <T>(
  options: UseLocalStorageOptions<T>,
): UseReactiveStorageReturn<T> => {
  return useReactiveStorage({
    key: options.key,
    storage: getDefaultLocalStorage(),
    initialValue: options.initialValue,
  });
};

/**
 * 使用 SessionSmartStorage 作为默认持久化实现的响应式 hook。
 */
export const useSessionStorage = <T>(
  options: UseSessionStorageOptions<T>,
): UseReactiveStorageReturn<T> => {
  return useReactiveStorage({
    key: options.key,
    storage: getDefaultSessionStorage(),
    initialValue: options.initialValue,
  });
};
