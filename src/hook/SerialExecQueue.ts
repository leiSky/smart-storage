/**
 * 极简串行执行队列。
 *
 * 同一个队列里的任务永远按提交顺序逐个执行，
 * 即使前一个任务失败，也不会打断后续任务继续排队。
 *
 * 这层只负责“顺序”，不负责业务语义：
 * - 不关心任务是 set、remove 还是 refresh
 * - 不负责记录错误状态
 * - 不做取消、优先级或合并
 */
export class SerialExecQueue {
  /** 当前等待执行的任务列表。 */
  private readonly tasks: Array<{
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  /** 当前是否已经有任务在消费队列。 */
  private running = false;

  /**
   * 把一个异步任务串到队列尾部，并返回该任务自己的执行结果。
   *
   * 如果任务失败：
   * - 当前这个 Promise 会 reject
   * - 但队列本身不会中断，后续任务仍然可以继续执行
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({
        run: task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      if (!this.running) {
        // 队列消费在后台启动即可；
        // 调用方真正等待的是自己这一个任务对应的 Promise。
        void this.drain();
      }
    });
  }

  /**
   * 顺序消费队列中的任务；失败不会打断后续任务继续执行。
   *
   * drain 是队列内部的后台循环：
   * - 调用方不需要显式等待它
   * - 调用方等待的是 `run()` 返回的那一个任务 Promise
   */
  private async drain() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      while (this.tasks.length > 0) {
        const currentTask = this.tasks.shift();

        if (!currentTask) {
          continue;
        }

        try {
          const result = await currentTask.run();
          currentTask.resolve(result);
        } catch (error) {
          currentTask.reject(error);
        }
      }
    } finally {
      this.running = false;

      if (this.tasks.length > 0) {
        // 当前 drain 退出前如果又有新任务进来，就补起下一轮消费。
        void this.drain();
      }
    }
  }
}
