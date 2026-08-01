import { relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { GatewayHttpError } from '../../http/errors.js'
import type { ProjectService } from '../projects/service.js'
import { GitCommandError, type GitCommandRunner } from './runner.js'

export interface GitRepositoryLocation {
  gitDirectory: string
  projectPath: string
  repositoryRoot: string
  repositoryPrefix: string
}

export async function resolveGitRepository(
  projects: ProjectService,
  runner: GitCommandRunner,
  projectId: string
): Promise<GitRepositoryLocation> {
  const project = projects.require(projectId)
  try {
    const projectPath = await realpath(project.path)
    const result = await runner.run(projectPath, [
      'rev-parse',
      '--show-toplevel',
      '--show-prefix',
      '--absolute-git-dir'
    ])
    const lines = result.stdout.toString('utf8').replace(/\r/g, '').split('\n')
    const repositoryRoot = lines[0]
    const repositoryPrefix = lines[1]
    const gitDirectory = lines[2]
    if (!repositoryRoot || repositoryPrefix === undefined || !gitDirectory) {
      throw new GatewayHttpError(
        500,
        'GIT_COMMAND_FAILED',
        'Git returned invalid repository metadata'
      )
    }
    const escaped = relative(repositoryRoot, projectPath)
    if (escaped === '..' || escaped.startsWith(`..${sep}`)) {
      throw new GatewayHttpError(422, 'GIT_NOT_REPOSITORY', 'Project is outside the Git worktree')
    }
    return {
      gitDirectory,
      projectPath,
      repositoryRoot,
      repositoryPrefix: normalizePrefix(repositoryPrefix)
    }
  } catch (error) {
    if (error instanceof GatewayHttpError) throw error
    if (error instanceof GitCommandError) {
      if (error.reason === 'spawn') {
        throw new GatewayHttpError(422, 'GIT_UNAVAILABLE', 'Git is not available on this Server')
      }
      if (error.result?.exitCode === 128) {
        throw new GatewayHttpError(422, 'GIT_NOT_REPOSITORY', 'Project is not a Git repository')
      }
    }
    throw new GatewayHttpError(500, 'GIT_COMMAND_FAILED', 'Unable to inspect Git repository')
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}
