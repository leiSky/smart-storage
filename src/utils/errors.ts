/**
 * 当调用方传入不可 JSON 序列化的值时抛出的明确错误类型。
 *
 * 业务侧可以直接按这个类型捕获，
 * 避免把参数问题和浏览器存储层本身的异常混在一起处理。
 */
export class StorageSerializationError extends TypeError {
  constructor(message = 'Storage value must be JSON-serializable') {
    super(message);
    this.name = 'StorageSerializationError';
  }
}
