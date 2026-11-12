/**
 * A first-come, first-served async lock. An agent's apply is "validate, write,
 * then lay out and write positions"; the layout step awaits ELK, so without a
 * lock a second apply could interleave and lay out a state the first one never
 * saw.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task);
    // Keep the chain alive whatever the task does; the caller sees its outcome.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
