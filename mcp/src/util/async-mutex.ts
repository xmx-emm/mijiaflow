export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(action: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => current, () => current);
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
