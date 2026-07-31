import type { AdapterEvent, AdapterId, RuntimeEvent, SessionId } from '@agent-gateway/core'

type Wake = () => void

/** Process-local append-only event stream. Durable storage is attached behind this boundary in M4.3. */
export class RuntimeSessionEventStream {
  private readonly history: RuntimeEvent[] = []
  private readonly wakes = new Set<Wake>()
  private sequence = 0
  private terminal: { kind: 'closed' } | { kind: 'failed'; error: unknown } | undefined

  constructor(
    private readonly sessionId: SessionId,
    private readonly adapterId: AdapterId,
    private readonly nextEventId: () => number,
  ) {}

  append(event: AdapterEvent, beforeCommit?: (event: RuntimeEvent) => void): RuntimeEvent {
    if (this.terminal) throw new Error(`Cannot append to terminal event stream: ${this.sessionId}`)
    const sequence = this.sequence + 1
    const sealed = {
      id: this.nextEventId(),
      sequence,
      sessionId: this.sessionId,
      adapterId: this.adapterId,
      timestamp: Date.now(),
      type: event.type,
      payload: event.payload,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.attribution ? { attribution: event.attribution } : {}),
      ...(event.nativeRef ? { nativeRef: event.nativeRef } : {}),
    } as RuntimeEvent
    beforeCommit?.(sealed)
    this.sequence = sequence
    this.history.push(sealed)
    this.wakeAll()
    return sealed
  }

  snapshot(afterSequence = 0): RuntimeEvent[] {
    return this.history.filter((event) => event.sequence > afterSequence)
  }

  subscribe(afterSequence = 0): AsyncIterable<RuntimeEvent> {
    return {
      [Symbol.asyncIterator]: () => this.iterate(afterSequence),
    }
  }

  close(): void {
    if (this.terminal) return
    this.terminal = { kind: 'closed' }
    this.wakeAll()
  }

  fail(error: unknown): void {
    if (this.terminal) return
    this.terminal = { kind: 'failed', error }
    this.wakeAll()
  }

  private waitForAppend(): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.wakes.delete(wake)
        resolve()
      }
      this.wakes.add(wake)
    })
  }

  private wakeAll(): void {
    for (const wake of [...this.wakes]) wake()
  }

  private async *iterate(afterSequence: number): AsyncGenerator<RuntimeEvent> {
    let nextSequence = afterSequence + 1
    while (true) {
      const available = this.history.find((event) => event.sequence >= nextSequence)
      if (available) {
        nextSequence = available.sequence + 1
        yield available
        continue
      }
      if (this.terminal?.kind === 'closed') return
      if (this.terminal?.kind === 'failed') throw this.terminal.error
      await this.waitForAppend()
    }
  }
}
