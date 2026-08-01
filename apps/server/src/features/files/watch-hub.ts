import { dirname, normalize } from 'node:path'
import type { WorkspaceFileEvent } from '@agent-gateway/shared'
import { watch, type FSWatcher } from 'chokidar'
import { GatewayHttpError } from '../../http/errors.js'
import type { WorkspaceFileService } from './service.js'

interface Subscriber {
  token: symbol
  projectId: string
  subscriptionId: string
  directories: Map<string, string>
  queue: AsyncEventQueue<WorkspaceFileEvent>
}

interface WatchedDirectory {
  relativePath: string
  references: number
}

interface ProjectWatcher {
  watcher: FSWatcher
  directories: Map<string, WatchedDirectory>
  pending: Set<string>
  flushTimer?: ReturnType<typeof setTimeout>
}

const INVALIDATION_DEBOUNCE_MS = 50

export class WorkspaceFileWatchHub {
  private readonly subscribers = new Map<string, Subscriber>()
  private readonly projects = new Map<string, ProjectWatcher>()

  constructor(
    private readonly files: Pick<WorkspaceFileService, 'directoryLocation'>,
    private readonly onError: (error: unknown, projectId: string) => void
  ) {}

  async open(projectId: string, subscriptionId: string): Promise<AsyncIterable<WorkspaceFileEvent>> {
    await this.files.directoryLocation(projectId, '')
    const key = subscriptionKey(projectId, subscriptionId)
    const previous = this.subscribers.get(key)
    if (previous) await this.remove(previous)

    const subscriber: Subscriber = {
      token: Symbol(subscriptionId),
      projectId,
      subscriptionId,
      directories: new Map(),
      queue: new AsyncEventQueue()
    }
    this.subscribers.set(key, subscriber)
    subscriber.queue.push({
      type: 'workspace.files.resync',
      projectId,
      subscriptionId,
      timestamp: Date.now()
    })
    return this.iterate(subscriber)
  }

  async update(projectId: string, subscriptionId: string, paths: string[]): Promise<void> {
    const subscriber = this.subscribers.get(subscriptionKey(projectId, subscriptionId))
    if (!subscriber) {
      throw new GatewayHttpError(
        404,
        'FILE_SUBSCRIPTION_NOT_FOUND',
        'Workspace file subscription was not found'
      )
    }

    const requested = new Set(['', ...paths])
    const locations = await Promise.all(
      [...requested].map((path) => this.files.directoryLocation(projectId, path))
    )
    const next = new Map(
      locations.map((location) => [location.relativePath, normalize(location.absolutePath)])
    )

    for (const [relativePath, absolutePath] of subscriber.directories) {
      if (next.has(relativePath)) continue
      await this.detach(projectId, absolutePath)
      subscriber.directories.delete(relativePath)
    }
    for (const [relativePath, absolutePath] of next) {
      if (subscriber.directories.has(relativePath)) continue
      this.attach(projectId, relativePath, absolutePath)
      subscriber.directories.set(relativePath, absolutePath)
    }
  }

  async close(): Promise<void> {
    const subscribers = [...this.subscribers.values()]
    this.subscribers.clear()
    for (const subscriber of subscribers) subscriber.queue.close()
    const watchers = [...this.projects.values()]
    this.projects.clear()
    await Promise.all(
      watchers.map(async (project) => {
        if (project.flushTimer) clearTimeout(project.flushTimer)
        await project.watcher.close()
      })
    )
  }

  private async *iterate(subscriber: Subscriber): AsyncGenerator<WorkspaceFileEvent> {
    try {
      yield* subscriber.queue
    } finally {
      const current = this.subscribers.get(
        subscriptionKey(subscriber.projectId, subscriber.subscriptionId)
      )
      if (current?.token === subscriber.token) await this.remove(subscriber)
    }
  }

  private attach(projectId: string, relativePath: string, absolutePath: string): void {
    const project = this.projectWatcher(projectId)
    const current = project.directories.get(absolutePath)
    if (current) {
      current.references += 1
      return
    }
    project.directories.set(absolutePath, { relativePath, references: 1 })
    project.watcher.add(absolutePath)
  }

  private async detach(projectId: string, absolutePath: string): Promise<void> {
    const project = this.projects.get(projectId)
    const current = project?.directories.get(absolutePath)
    if (!project || !current) return
    current.references -= 1
    if (current.references > 0) return
    project.directories.delete(absolutePath)
    await project.watcher.unwatch(absolutePath)
    if (project.directories.size === 0) {
      if (project.flushTimer) clearTimeout(project.flushTimer)
      if (this.projects.get(projectId) === project) this.projects.delete(projectId)
      await project.watcher.close()
    }
  }

  private projectWatcher(projectId: string): ProjectWatcher {
    const existing = this.projects.get(projectId)
    if (existing) return existing

    const watcher = watch([], {
      depth: 0,
      followSymlinks: false,
      ignoreInitial: true,
      persistent: true
    })
    const project: ProjectWatcher = {
      watcher,
      directories: new Map(),
      pending: new Set()
    }
    watcher.on('all', (_event, path) => this.invalidate(projectId, normalize(path)))
    watcher.on('error', (error) => {
      this.onError(error, projectId)
      this.resync(projectId)
    })
    this.projects.set(projectId, project)
    return project
  }

  private invalidate(projectId: string, changedPath: string): void {
    const project = this.projects.get(projectId)
    if (!project) return
    const parent = project.directories.get(dirname(changedPath))
    const changedDirectory = project.directories.get(changedPath)
    if (parent) project.pending.add(parent.relativePath)
    if (changedDirectory) project.pending.add(changedDirectory.relativePath)
    if (project.pending.size === 0 || project.flushTimer) return
    project.flushTimer = setTimeout(() => this.flush(projectId), INVALIDATION_DEBOUNCE_MS)
  }

  private flush(projectId: string): void {
    const project = this.projects.get(projectId)
    if (!project) return
    project.flushTimer = undefined
    const paths = [...project.pending].sort()
    project.pending.clear()
    if (paths.length === 0) return

    for (const subscriber of this.subscribers.values()) {
      if (subscriber.projectId !== projectId) continue
      const relevant = paths.filter((path) => subscriber.directories.has(path))
      if (relevant.length === 0) continue
      subscriber.queue.push({
        type: 'workspace.files.invalidated',
        projectId,
        subscriptionId: subscriber.subscriptionId,
        paths: relevant,
        timestamp: Date.now()
      })
    }
  }

  private resync(projectId: string): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.projectId !== projectId) continue
      subscriber.queue.push({
        type: 'workspace.files.resync',
        projectId,
        subscriptionId: subscriber.subscriptionId,
        timestamp: Date.now()
      })
    }
  }

  private async remove(subscriber: Subscriber): Promise<void> {
    const key = subscriptionKey(subscriber.projectId, subscriber.subscriptionId)
    const current = this.subscribers.get(key)
    if (current?.token === subscriber.token) this.subscribers.delete(key)
    subscriber.queue.close()
    for (const absolutePath of subscriber.directories.values()) {
      await this.detach(subscriber.projectId, absolutePath)
    }
    subscriber.directories.clear()
  }
}

function subscriptionKey(projectId: string, subscriptionId: string): string {
  return `${projectId}:${subscriptionId}`
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ done: true, value: undefined })
      }
    }
  }
}
