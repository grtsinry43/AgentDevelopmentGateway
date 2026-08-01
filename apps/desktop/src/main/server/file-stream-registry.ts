import { randomUUID } from 'node:crypto'
import type { WorkspaceFileEvent } from '@agent-gateway/shared'
import { PUSH_CHANNEL, type PushEvent } from '../../contract/bridge.js'

interface ActiveFileStream {
  controller: AbortController
  directories: Set<string>
  projectId: string
  projectKey: string
  subscriptionId?: string
  task: Promise<void>
}

export interface WorkspaceFileStreamClient {
  workspaceFileEvents(
    projectId: string,
    subscriptionId: string,
    signal: AbortSignal,
    onOpen?: () => void
  ): AsyncIterable<WorkspaceFileEvent>
  updateWorkspaceFileSubscription(
    projectId: string,
    subscriptionId: string,
    directories: string[]
  ): Promise<void>
}

export interface FileStreamContents {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  send(channel: string, event: PushEvent): void
}

const FAST_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const
const SLOW_RETRY_DELAY_MS = 15_000

/** Owns one invalidation stream for each renderer and Project file tree. */
export class FileStreamRegistry {
  private readonly active = new Map<string, ActiveFileStream>()
  private readonly observedWebContents = new Set<number>()

  constructor(private readonly client: WorkspaceFileStreamClient) {}

  watch(
    contents: FileStreamContents,
    projectKey: string,
    projectId: string,
    directories: string[]
  ): void {
    const key = streamKey(contents.id, projectKey)
    this.active.get(key)?.controller.abort()
    const controller = new AbortController()
    this.observeDestruction(contents)
    this.send(contents, { kind: 'files.stream', projectKey, state: 'connecting' })

    const entry: ActiveFileStream = {
      controller,
      directories: new Set(directories),
      projectId,
      projectKey,
      task: Promise.resolve()
    }
    entry.task = this.consume(contents, entry).finally(() => {
      if (this.active.get(key) === entry) this.active.delete(key)
    })
    this.active.set(key, entry)
  }

  async update(contents: FileStreamContents, projectKey: string, directories: string[]): Promise<void> {
    const entry = this.active.get(streamKey(contents.id, projectKey))
    if (!entry) throw new Error('文件事件流尚未启动')
    entry.directories = new Set(directories)
    const subscriptionId = entry.subscriptionId
    if (!subscriptionId) return
    try {
      await this.client.updateWorkspaceFileSubscription(
        entry.projectId,
        subscriptionId,
        [...entry.directories]
      )
    } catch (error) {
      if (entry.subscriptionId !== subscriptionId || hasCode(error, 'FILE_SUBSCRIPTION_NOT_FOUND')) {
        return
      }
      throw error
    }
  }

  unwatch(contents: FileStreamContents, projectKey: string): void {
    this.active.get(streamKey(contents.id, projectKey))?.controller.abort()
  }

  retry(contents: FileStreamContents, projectKey: string): void {
    const entry = this.active.get(streamKey(contents.id, projectKey))
    if (!entry) throw new Error('文件事件流尚未启动')
    this.watch(contents, entry.projectKey, entry.projectId, [...entry.directories])
  }

  private async consume(contents: FileStreamContents, entry: ActiveFileStream): Promise<void> {
    let consecutiveFailures = 0
    while (!entry.controller.signal.aborted) {
      const subscriptionId = randomUUID()
      entry.subscriptionId = subscriptionId
      try {
        for await (const event of this.client.workspaceFileEvents(
          entry.projectId,
          subscriptionId,
          entry.controller.signal
        )) {
          consecutiveFailures = 0
          if (event.type === 'workspace.files.resync') {
            await this.client.updateWorkspaceFileSubscription(
              entry.projectId,
              subscriptionId,
              [...entry.directories]
            )
            this.send(contents, {
              kind: 'files.stream',
              projectKey: entry.projectKey,
              state: 'connected'
            })
            this.send(contents, { kind: 'files.resync', projectKey: entry.projectKey })
          } else {
            this.send(contents, {
              kind: 'files.invalidated',
              projectKey: entry.projectKey,
              paths: event.paths
            })
          }
        }
        if (entry.controller.signal.aborted) return
        throw new Error('Workspace file event stream closed unexpectedly')
      } catch (error) {
        if (entry.controller.signal.aborted || isAbortError(error)) return
        if (!isRetryable(error)) {
          this.send(contents, {
            kind: 'files.stream',
            projectKey: entry.projectKey,
            state: 'error',
            message: errorMessage(error)
          })
          return
        }
        consecutiveFailures += 1
        const delay = retryDelay(consecutiveFailures)
        this.send(contents, {
          kind: 'files.stream',
          projectKey: entry.projectKey,
          state: 'retrying',
          message: `${errorMessage(error)}；正在后台重新连接文件事件流`,
          attempt: consecutiveFailures,
          retryAt: Date.now() + delay
        })
        if (!(await waitForRetry(delay, entry.controller.signal))) return
      } finally {
        if (entry.subscriptionId === subscriptionId) entry.subscriptionId = undefined
      }
    }
  }

  private observeDestruction(contents: FileStreamContents): void {
    if (this.observedWebContents.has(contents.id)) return
    this.observedWebContents.add(contents.id)
    contents.once('destroyed', () => {
      this.observedWebContents.delete(contents.id)
      const prefix = `${contents.id}:`
      for (const [key, entry] of this.active) {
        if (key.startsWith(prefix)) entry.controller.abort()
      }
    })
  }

  private send(contents: FileStreamContents, event: PushEvent): void {
    if (!contents.isDestroyed()) contents.send(PUSH_CHANNEL, event)
  }
}

function streamKey(webContentsId: number, projectKey: string): string {
  return `${webContentsId}:${projectKey}`
}

function retryDelay(attempt: number): number {
  return FAST_RETRY_DELAYS_MS[attempt - 1] ?? SLOW_RETRY_DELAY_MS
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve(true)
    }, delayMs)
    const abort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRetryable(error: unknown): boolean {
  return !(
    hasCode(error, 'PROJECT_NOT_FOUND') ||
    hasCode(error, 'PROJECT_UNAVAILABLE') ||
    hasCode(error, 'CAPABILITY_UNSUPPORTED')
  )
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workspace file event stream failed'
}
