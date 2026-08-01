import type {
  GitChange,
  GitChangeArea,
  GitCommitResponse,
  GitDiffResponse,
  GitRepositoryState
} from '@agent-gateway/shared'
import { GatewayHttpError } from '../../http/errors.js'
import type { ProjectService } from '../projects/service.js'
import { applyNumstat, parseGitPatch, parseGitStatus } from './parser.js'
import { resolveGitRepository } from './repository.js'
import { GitCommandError, type GitCommandRunner } from './runner.js'

const DIFF_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024

export class GitService {
  private readonly mutations = new Map<string, Promise<void>>()

  constructor(
    private readonly projects: ProjectService,
    private readonly runner: GitCommandRunner,
    private readonly publishChanged: (projectId: string) => void
  ) {}

  async status(projectId: string): Promise<GitRepositoryState> {
    const repository = await resolveGitRepository(this.projects, this.runner, projectId)
    try {
      const [status, stagedStats, unstagedStats] = await Promise.all([
        this.runner.run(repository.projectPath, [
          'status',
          '--porcelain=v2',
          '-z',
          '--branch',
          '--untracked-files=all',
          '--',
          '.'
        ]),
        this.runner.run(repository.projectPath, [
          'diff',
          '--cached',
          '--numstat',
          '-z',
          '--no-renames',
          '--',
          '.'
        ]),
        this.runner.run(repository.projectPath, [
          'diff',
          '--numstat',
          '-z',
          '--no-renames',
          '--',
          '.'
        ])
      ])
      const parsed = parseGitStatus(status.stdout, repository.repositoryPrefix)
      applyNumstat(parsed.changes, stagedStats.stdout, 'staged', repository.repositoryPrefix)
      applyNumstat(parsed.changes, unstagedStats.stdout, 'unstaged', repository.repositoryPrefix)
      return { branch: parsed.branch, changes: parsed.changes, updatedAt: Date.now() }
    } catch (error) {
      throw mapGitError(error, 'Unable to read Git status')
    }
  }

  async diff(projectId: string, path: string, area: GitChangeArea): Promise<GitDiffResponse> {
    const normalizedPath = validatePath(path)
    const state = await this.status(projectId)
    const change = state.changes.find((item) => item.path === normalizedPath && item.area === area)
    if (!change) throw staleState()
    const repository = await resolveGitRepository(this.projects, this.runner, projectId)

    try {
      const result = await this.runner.run(
        repository.projectPath,
        diffArguments(change),
        area === 'untracked'
          ? { allowedExitCodes: [0, 1], maxOutputBytes: DIFF_MAX_OUTPUT_BYTES }
          : { maxOutputBytes: DIFF_MAX_OUTPUT_BYTES }
      )
      return { change: parseGitPatch(result.stdout.toString('utf8'), change) }
    } catch (error) {
      if (error instanceof GitCommandError && error.reason === 'output-limit') {
        return {
          change: parseGitPatch(error.result?.stdout.toString('utf8') ?? '', change, true)
        }
      }
      throw mapGitError(error, 'Unable to read Git diff')
    }
  }

  stage(projectId: string, paths: string[]): Promise<void> {
    return this.mutate(projectId, async () => {
      const normalizedPaths = validatePaths(paths)
      const state = await this.status(projectId)
      requireChanges(state.changes, normalizedPaths, ['conflict', 'unstaged', 'untracked'])
      const repository = await resolveGitRepository(this.projects, this.runner, projectId)
      try {
        await this.runner.run(
          repository.projectPath,
          [
            '--literal-pathspecs',
            'add',
            '--all',
            '--pathspec-from-file=-',
            '--pathspec-file-nul'
          ],
          { input: encodePaths(normalizedPaths) }
        )
      } catch (error) {
        throw mapGitError(error, 'Unable to stage Git changes')
      }
      this.publishChanged(projectId)
    })
  }

  unstage(projectId: string, paths: string[]): Promise<void> {
    return this.mutate(projectId, async () => {
      const normalizedPaths = validatePaths(paths)
      const state = await this.status(projectId)
      requireChanges(state.changes, normalizedPaths, ['staged'])
      const repository = await resolveGitRepository(this.projects, this.runner, projectId)
      try {
        const args = state.branch.oid
          ? [
              '--literal-pathspecs',
              'restore',
              '--staged',
              '--pathspec-from-file=-',
              '--pathspec-file-nul'
            ]
          : [
              '--literal-pathspecs',
              'rm',
              '--cached',
              '--force',
              '--ignore-unmatch',
              '-r',
              '--pathspec-from-file=-',
              '--pathspec-file-nul'
            ]
        await this.runner.run(repository.projectPath, args, { input: encodePaths(normalizedPaths) })
      } catch (error) {
        throw mapGitError(error, 'Unable to unstage Git changes')
      }
      this.publishChanged(projectId)
    })
  }

  commit(projectId: string, message: string): Promise<GitCommitResponse> {
    return this.mutate(projectId, async () => {
      const state = await this.status(projectId)
      if (!state.changes.some((change) => change.area === 'staged')) {
        throw new GatewayHttpError(409, 'GIT_NOTHING_TO_COMMIT', 'There are no staged changes')
      }
      const repository = await resolveGitRepository(this.projects, this.runner, projectId)
      try {
        const committed = await this.runner.run(
          repository.projectPath,
          ['commit', '--file=-', '--cleanup=strip'],
          { input: `${message.trim()}\n`, timeoutMs: 120_000 }
        )
        const head = await this.runner.run(repository.projectPath, ['rev-parse', 'HEAD'])
        const oid = head.stdout.toString('utf8').trim()
        if (!oid) throw new Error('Git did not return the new commit oid')
        this.publishChanged(projectId)
        return { oid, summary: committed.stdout.toString('utf8').trim() }
      } catch (error) {
        throw mapGitError(error, 'Unable to commit staged changes')
      }
    })
  }

  private mutate<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(projectId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.mutations.set(projectId, tail)
    void tail.finally(() => {
      if (this.mutations.get(projectId) === tail) this.mutations.delete(projectId)
    })
    return result
  }
}

function diffArguments(change: GitChange): string[] {
  const common = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color']
  if (change.area === 'staged') return [...common, '--cached', '--', change.path]
  if (change.area === 'untracked') {
    return [...common, '--no-index', '--', '/dev/null', change.path]
  }
  return [...common, '--', change.path]
}

function validatePaths(paths: string[]): string[] {
  return [...new Set(paths.map(validatePath))]
}

function validatePath(path: string): string {
  if (
    !path ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw invalidPath()
  }
  const segments = path.split(/[\\/]/)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalidPath()
  }
  return segments.join('/')
}

function invalidPath(): GatewayHttpError {
  return new GatewayHttpError(
    400,
    'INVALID_WORKSPACE_PATH',
    'Git path must be a canonical project-relative path'
  )
}

function requireChanges(
  changes: GitChange[],
  paths: string[],
  areas: GitChangeArea[]
): void {
  const available = new Set(
    changes.filter((change) => areas.includes(change.area)).map((change) => change.path)
  )
  if (paths.some((path) => !available.has(path))) throw staleState()
}

function staleState(): GatewayHttpError {
  return new GatewayHttpError(409, 'GIT_STATE_CHANGED', 'Git state changed; refresh and try again')
}

function encodePaths(paths: string[]): Buffer {
  return Buffer.from(`${paths.join('\0')}\0`, 'utf8')
}

function mapGitError(error: unknown, fallback: string): GatewayHttpError {
  if (error instanceof GatewayHttpError) return error
  if (error instanceof GitCommandError) {
    if (error.reason === 'spawn') {
      return new GatewayHttpError(422, 'GIT_UNAVAILABLE', 'Git is not available on this Server')
    }
    return new GatewayHttpError(409, 'GIT_COMMAND_FAILED', error.message)
  }
  return new GatewayHttpError(500, 'GIT_COMMAND_FAILED', fallback)
}
