import type { SDKControlInitializeResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue, type ClaudeQuery } from '../../src/index.js'

export class FakeClaudeQuery implements ClaudeQuery {
  readonly messages = new AsyncQueue<SDKMessage>()
  readonly models: Array<string | undefined> = []
  interruptCount = 0
  closed = false

  private readonly initialization = deferred<SDKControlInitializeResponse>()

  initializationResult(): Promise<SDKControlInitializeResponse> {
    return this.initialization.promise
  }

  resolveInitialization(): void {
    this.initialization.resolve({
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: [],
      account: {},
    })
  }

  rejectInitialization(error: unknown): void {
    this.initialization.reject(error)
  }

  interrupt(): Promise<unknown> {
    this.interruptCount += 1
    return Promise.resolve(undefined)
  }

  setModel(model?: string): Promise<unknown> {
    this.models.push(model)
    return Promise.resolve(undefined)
  }

  close(): void {
    this.closed = true
    this.messages.close()
  }

  emit(message: SDKMessage): void {
    this.messages.push(message)
  }

  fail(error: unknown): void {
    this.messages.fail(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]()
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((error: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value) => resolvePromise!(value),
    reject: (error) => rejectPromise!(error),
  }
}
