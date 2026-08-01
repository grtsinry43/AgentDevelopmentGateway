import { join, relative, sep } from 'node:path'
import type { GitEvent } from '@agent-gateway/shared'
import { watch, type FSWatcher } from 'chokidar'
import type { ProjectService } from '../projects/service.js'
import { WorkspaceFilePolicy } from '../files/policy.js'
import { resolveGitRepository } from './repository.js'
import type { GitCommandRunner } from './runner.js'

interface Subscriber {
  projectId: string
  queue: AsyncEventQueue<GitEvent>
}

interface ProjectWatcher {
  metadata: FSWatcher
  pending?: ReturnType<typeof setTimeout>
  references: number
  worktree: FSWatcher
}

const INVALIDATION_DEBOUNCE_MS = 75

export class GitWatchHub {
  private readonly projects = new Map<string, ProjectWatcher>()
  private readonly subscribers = new Set<Subscriber>()

  constructor(
    private readonly projectsService: ProjectService,
    private readonly runner: GitCommandRunner,
    private readonly onError: (error: unknown, projectId: string) => void,
    private readonly filePolicy = new WorkspaceFilePolicy()
  ) {}

  async open(projectId: string): Promise<AsyncIterable<GitEvent>> {
    const subscriber: Subscriber = {
      projectId,
      queue: new AsyncEventQueue()
    }
    await this.attach(projectId)
    this.subscribers.add(subscriber)
    return this.iterate(subscriber)
  }

  notify(projectId: string): void {
    const project = this.projects.get(projectId)
    if (!project || project.pending) return
    project.pending = setTimeout(() => this.flush(projectId), INVALIDATION_DEBOUNCE_MS)
  }

  async close(): Promise<void> {
    for (const subscriber of this.subscribers) subscriber.queue.close()
    this.subscribers.clear()
    const watchers = [...this.projects.values()]
    this.projects.clear()
    await Promise.all(
      watchers.flatMap((project) => {
        if (project.pending) clearTimeout(project.pending)
        return [project.worktree.close(), project.metadata.close()]
      })
    )
  }

  private async attach(projectId: string): Promise<void> {
    const existing = this.projects.get(projectId)
    if (existing) {
      existing.references += 1
      return
    }
    const repository = await resolveGitRepository(this.projectsService, this.runner, projectId)
    const worktree = watch(repository.projectPath, {
      followSymlinks: false,
      ignoreInitial: true,
      ignored: (path, stats) => this.ignoreWorktreePath(repository.projectPath, path, stats),
      persistent: true
    })
    const metadata = watch(
      [
        join(repository.gitDirectory, 'HEAD'),
        join(repository.gitDirectory, 'index'),
        join(repository.gitDirectory, 'packed-refs'),
        join(repository.gitDirectory, 'refs')
      ],
      { followSymlinks: false, ignoreInitial: true, persistent: true }
    )
    const project: ProjectWatcher = { metadata, references: 1, worktree }
    const changed = (): void => this.notify(projectId)
    const failed = (error: unknown): void => {
      this.onError(error, projectId)
      this.fail(projectId)
    }
    worktree.on('all', changed)
    metadata.on('all', changed)
    worktree.on('error', failed)
    metadata.on('error', failed)
    this.projects.set(projectId, project)
  }

  private async *iterate(subscriber: Subscriber): AsyncGenerator<GitEvent> {
    try {
      yield* subscriber.queue
    } finally {
      if (this.subscribers.delete(subscriber)) await this.detach(subscriber.projectId)
    }
  }

  private async detach(projectId: string): Promise<void> {
    const project = this.projects.get(projectId)
    if (!project) return
    project.references -= 1
    if (project.references > 0) return
    this.projects.delete(projectId)
    if (project.pending) clearTimeout(project.pending)
    await Promise.all([project.worktree.close(), project.metadata.close()])
  }

  private flush(projectId: string): void {
    const project = this.projects.get(projectId)
    if (!project) return
    project.pending = undefined
    const event: GitEvent = { type: 'workspace.git.changed', projectId, timestamp: Date.now() }
    for (const subscriber of this.subscribers) {
      if (subscriber.projectId === projectId) subscriber.queue.push(event)
    }
  }

  private fail(projectId: string): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.projectId !== projectId) continue
      subscriber.queue.close()
    }
  }

  private ignoreWorktreePath(root: string, path: string, stats?: { isDirectory(): boolean }): boolean {
    const child = relative(root, path)
    if (!child || child === '.') return false
    if (child === '..' || child.startsWith(`..${sep}`)) return true
    const first = child.split(sep, 1)[0]
    return first === '.git' || (stats?.isDirectory() === true && this.filePolicy.isGeneratedDirectory(first ?? ''))
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []

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
