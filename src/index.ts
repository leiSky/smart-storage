import LocalSmartStorage from './local/localSmartStorage';
import SessionSmartStorage from './session/sessionSmartStorage';

export { LocalSmartStorage, SessionSmartStorage };
export {
  useLocalStorage,
  useSessionStorage,
} from './hook/index';
export { StorageSerializationError } from './utils/errors';
export type * from './types/types';
export type {
  UseStorageHookOptions,
  UseLocalStorageOptions,
  UseSessionStorageOptions,
} from './hook/index';
