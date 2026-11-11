/** Serializes image actions by block within this feature instance. Host writes still have no CAS. */
export class BlockActionCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(blockID: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(blockID) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(blockID, tail);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.tails.get(blockID) === tail) this.tails.delete(blockID);
    }
  }
}
