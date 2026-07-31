/** A closeable, single-consumer async queue used for SDK input and adapter events. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private terminal: { kind: 'closed' } | { kind: 'failed'; error: unknown } | undefined
  private iteratorCreated = false

  push(value: T): void {
    if (this.terminal) throw new Error('Cannot push to a closed async queue')
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.terminal) return
    this.terminal = { kind: 'closed' }
    this.settleWaiters()
  }

  fail(error: unknown): void {
    if (this.terminal) return
    this.terminal = { kind: 'failed', error }
    this.settleWaiters()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iteratorCreated) throw new Error('AsyncQueue supports exactly one consumer')
    this.iteratorCreated = true
    return {
      next: () => this.next(),
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.terminal?.kind === 'closed') return Promise.resolve({ value: undefined, done: true })
    if (this.terminal?.kind === 'failed') return Promise.reject(this.terminal.error)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private settleWaiters(): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      if (this.terminal?.kind === 'failed') waiter.reject(this.terminal.error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }
}
