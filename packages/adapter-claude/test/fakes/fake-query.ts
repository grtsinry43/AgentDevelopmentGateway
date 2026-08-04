import type { ModelInfo, SDKControlInitializeResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue, type ClaudeQuery } from '../../src/index.js'

export class FakeClaudeQuery implements ClaudeQuery {
  readonly messages = new AsyncQueue<SDKMessage>()
  readonly models: Array<string | undefined> = []
  readonly modelCatalog: ModelInfo[] = []
  readonly commands: Array<import('@anthropic-ai/claude-agent-sdk').SlashCommand> = []
  readonly flagSettings: Array<{
    model?: string | null
    effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  }> = []
  readonly permissionModes: PermissionMode[] = []
  readonly rewindCalls: Array<{ userMessageId: string; dryRun?: boolean }> = []
  readonly rewindResults: Array<import('@anthropic-ai/claude-agent-sdk').RewindFilesResult> = []
  interruptCount = 0
  closed = false

  private readonly initialization = deferred<SDKControlInitializeResponse>()

  initializationResult(): Promise<SDKControlInitializeResponse> {
    return this.initialization.promise
  }

  supportedModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.modelCatalog.map((model) => ({ ...model })))
  }

  supportedCommands(): Promise<import('@anthropic-ai/claude-agent-sdk').SlashCommand[]> {
    return Promise.resolve(this.commands.map((command) => ({ ...command })))
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

  applyFlagSettings(settings: {
    model?: string | null
    effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  }): Promise<unknown> {
    this.flagSettings.push({ ...settings })
    return Promise.resolve(undefined)
  }

  setPermissionMode(mode: PermissionMode): Promise<unknown> {
    this.permissionModes.push(mode)
    return Promise.resolve(undefined)
  }

  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<import('@anthropic-ai/claude-agent-sdk').RewindFilesResult> {
    this.rewindCalls.push({ userMessageId, dryRun: options?.dryRun })
    return Promise.resolve(
      this.rewindResults.shift() ?? { canRewind: false, error: 'not staged' },
    )
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
