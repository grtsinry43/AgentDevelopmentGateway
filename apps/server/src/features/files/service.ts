import type { Dirent } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep, win32 } from 'node:path'
import type {
  WorkspaceDirectoryResponse,
  WorkspaceFileContentResponse,
  WorkspaceFileCreateRequest,
  WorkspaceFileKind,
  WorkspaceFileMoveRequest,
  WorkspaceFileWriteRequest,
} from '@agent-gateway/shared'
import { GatewayHttpError } from '../../http/errors.js'
import type { ProjectService } from '../projects/service.js'
import { WorkspaceFilePolicy } from './policy.js'

export interface WorkspaceDirectoryLocation {
  absolutePath: string
  relativePath: string
}

/** Soft limit for text preview; larger files are rejected rather than streamed. */
const MAX_PREVIEW_BYTES = 512 * 1024

export class WorkspaceFileService {
  constructor(
    private readonly projects: ProjectService,
    private readonly policy = new WorkspaceFilePolicy()
  ) {}

  async list(projectId: string, inputPath: string): Promise<WorkspaceDirectoryResponse> {
    const location = await this.directoryLocation(projectId, inputPath)
    let entries
    try {
      entries = await readdir(location.absolutePath, { withFileTypes: true })
    } catch (error) {
      throw mapFileError(error, false)
    }

    const nodes = await Promise.all(
      entries
        .filter((entry) => !this.policy.isHidden(entry.name))
        .map(async (entry) => {
          const kind = await resolveEntryKind(location.absolutePath, entry)
          const path = location.relativePath
            ? `${location.relativePath}/${entry.name}`
            : entry.name
          return {
            name: entry.name,
            path,
            kind,
            generated: kind === 'directory' && this.policy.isGeneratedDirectory(entry.name)
          }
        })
    )

    nodes.sort(compareNodes)
    return { path: location.relativePath, entries: nodes }
  }

  async create(projectId: string, input: WorkspaceFileCreateRequest): Promise<void> {
    const location = await this.resolveCreateTarget(projectId, input.path)
    try {
      if (input.kind === 'directory') {
        await mkdir(location.absolutePath)
      } else {
        await writeFile(location.absolutePath, '', { flag: 'wx' })
      }
    } catch (error) {
      throw mapFileError(error, false)
    }
  }

  async write(projectId: string, input: WorkspaceFileWriteRequest): Promise<void> {
    const location = await this.fileLocation(projectId, input.path)
    if (Buffer.byteLength(input.content, 'utf8') > MAX_PREVIEW_BYTES) {
      throw new GatewayHttpError(
        422,
        'FILE_TOO_LARGE',
        `File exceeds the ${MAX_PREVIEW_BYTES} byte write limit`
      )
    }
    try {
      await writeFile(location.absolutePath, input.content, 'utf8')
    } catch (error) {
      throw mapFileError(error, true)
    }
  }

  async move(projectId: string, input: WorkspaceFileMoveRequest): Promise<void> {
    const source = await this.resolveLocation(projectId, input.from)
    const target = await this.resolveCreateTarget(projectId, input.to)
    if (source.relativePath === target.relativePath) return
    if (target.relativePath.startsWith(`${source.relativePath}/`)) {
      throw new GatewayHttpError(
        422,
        'INVALID_MOVE_TARGET',
        'Cannot move a path into its own subtree'
      )
    }
    let sourceStats
    try {
      sourceStats = await lstat(source.absolutePath)
    } catch (error) {
      throw mapFileError(error, true)
    }
    if (sourceStats.isSymbolicLink()) {
      throw new GatewayHttpError(422, 'INVALID_MOVE_TARGET', 'Symbolic links cannot be moved')
    }
    let targetStats
    try {
      targetStats = await lstat(target.absolutePath)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw mapFileError(error, false)
    }
    if (targetStats) {
      throw new GatewayHttpError(409, 'PATH_EXISTS', 'Workspace path already exists')
    }
    try {
      await rename(source.absolutePath, target.absolutePath)
    } catch (error) {
      throw mapFileError(error, false)
    }
  }

  async remove(projectId: string, inputPath: string): Promise<void> {
    const location = await this.resolveLocation(projectId, inputPath)
    try {
      await rm(location.absolutePath, { recursive: true, force: false })
    } catch (error) {
      throw mapFileError(error, false)
    }
  }

  async copy(projectId: string, input: WorkspaceFileMoveRequest): Promise<void> {
    const source = await this.resolveLocation(projectId, input.from)
    const target = await this.resolveCreateTarget(projectId, input.to)
    if (source.relativePath === target.relativePath) return
    if (target.relativePath.startsWith(`${source.relativePath}/`)) {
      throw new GatewayHttpError(
        422,
        'INVALID_MOVE_TARGET',
        'Cannot copy a path into its own subtree'
      )
    }
    let sourceStats
    try {
      sourceStats = await lstat(source.absolutePath)
    } catch (error) {
      throw mapFileError(error, true)
    }
    if (sourceStats.isSymbolicLink()) {
      throw new GatewayHttpError(422, 'INVALID_MOVE_TARGET', 'Symbolic links cannot be copied')
    }
    let targetStats
    try {
      targetStats = await lstat(target.absolutePath)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw mapFileError(error, false)
    }
    if (targetStats) {
      throw new GatewayHttpError(409, 'PATH_EXISTS', 'Workspace path already exists')
    }
    try {
      await cp(source.absolutePath, target.absolutePath, {
        recursive: true,
        errorOnExist: true,
        force: false
      })
    } catch (error) {
      throw mapFileError(error, false)
    }
  }

  /** 下载位置:文件返回源流位置,目录返回待打包位置。 */
  async downloadLocation(
    projectId: string,
    inputPath: string
  ): Promise<WorkspaceDirectoryLocation & { kind: WorkspaceFileKind }> {
    const location = await this.resolveLocation(projectId, inputPath)
    let stats
    try {
      stats = await lstat(location.absolutePath)
    } catch (error) {
      throw mapFileError(error, true)
    }
    if (stats.isSymbolicLink()) {
      throw new GatewayHttpError(422, 'INVALID_WORKSPACE_PATH', 'Symbolic links cannot be downloaded')
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new GatewayHttpError(422, 'NOT_A_FILE', 'Workspace path is not downloadable')
    }
    return { ...location, kind: stats.isDirectory() ? 'directory' : 'file' }
  }

  async read(projectId: string, inputPath: string): Promise<WorkspaceFileContentResponse> {
    const location = await this.fileLocation(projectId, inputPath)
    let stats
    try {
      stats = await lstat(location.absolutePath)
    } catch (error) {
      throw mapFileError(error, true)
    }
    if (stats.size > MAX_PREVIEW_BYTES) {
      throw new GatewayHttpError(
        422,
        'FILE_TOO_LARGE',
        `File exceeds the ${MAX_PREVIEW_BYTES} byte preview limit`
      )
    }

    let buffer: Buffer
    try {
      buffer = await readFile(location.absolutePath)
    } catch (error) {
      throw mapFileError(error, true)
    }
    if (buffer.includes(0)) {
      throw new GatewayHttpError(422, 'BINARY_FILE', 'Binary files cannot be previewed as text')
    }

    return {
      path: location.relativePath,
      content: buffer.toString('utf8'),
      size: buffer.byteLength,
    }
  }

  async directoryLocation(
    projectId: string,
    inputPath: string
  ): Promise<WorkspaceDirectoryLocation> {
    const location = await this.resolveLocation(projectId, inputPath)
    let stats
    try {
      stats = await lstat(location.absolutePath)
    } catch (error) {
      throw mapFileError(error, true)
    }
    if (!stats.isDirectory()) {
      throw new GatewayHttpError(422, 'NOT_A_DIRECTORY', 'Workspace path is not a directory')
    }
    return location
  }

  async fileLocation(projectId: string, inputPath: string): Promise<WorkspaceDirectoryLocation> {
    if (inputPath === '') {
      throw new GatewayHttpError(
        400,
        'INVALID_WORKSPACE_PATH',
        'Workspace file path cannot be empty'
      )
    }
    const location = await this.resolveLocation(projectId, inputPath)
    let stats
    try {
      stats = await lstat(location.absolutePath)
    } catch (error) {
      throw mapFileError(error, true)
    }
    if (stats.isDirectory()) {
      throw new GatewayHttpError(422, 'NOT_A_FILE', 'Workspace path is a directory')
    }
    if (!stats.isFile()) {
      throw new GatewayHttpError(422, 'NOT_A_FILE', 'Workspace path is not a regular file')
    }
    return location
  }

  private async resolveLocation(
    projectId: string,
    inputPath: string
  ): Promise<WorkspaceDirectoryLocation> {
    return this.resolvePathSegments(projectId, inputPath, true)
  }

  /** 目标路径不存在也要能解析(创建/移动目标):最后一段可不存,父目录必须存在。 */
  private async resolveCreateTarget(
    projectId: string,
    inputPath: string
  ): Promise<WorkspaceDirectoryLocation> {
    return this.resolvePathSegments(projectId, inputPath, false)
  }

  private async resolvePathSegments(
    projectId: string,
    inputPath: string,
    requireLeaf: boolean
  ): Promise<WorkspaceDirectoryLocation> {
    const project = this.projects.require(projectId)
    const relativePath = normalizeWorkspacePath(inputPath)
    const segments = relativePath ? relativePath.split('/') : []
    if (!requireLeaf && segments.length === 0) {
      throw new GatewayHttpError(400, 'INVALID_WORKSPACE_PATH', 'Workspace path cannot be empty')
    }
    const walkedSegments = requireLeaf ? segments : segments.slice(0, -1)

    let root: string
    try {
      root = await realpath(project.path)
      const rootStat = await lstat(root)
      if (!rootStat.isDirectory()) {
        throw new GatewayHttpError(422, 'PROJECT_UNAVAILABLE', 'Project path is not a directory')
      }
    } catch (error) {
      if (error instanceof GatewayHttpError) throw error
      throw new GatewayHttpError(422, 'PROJECT_UNAVAILABLE', 'Project path is unavailable')
    }

    let current = root
    for (const segment of walkedSegments) {
      current = join(current, segment)
      let stats
      try {
        stats = await lstat(current)
      } catch (error) {
        throw mapFileError(error, true)
      }
      if (stats.isSymbolicLink()) {
        throw new GatewayHttpError(
          422,
          'INVALID_WORKSPACE_PATH',
          'Symbolic links cannot be expanded'
        )
      }
    }

    if (requireLeaf) {
      const escaped = relative(root, current)
      if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
        throw new GatewayHttpError(
          400,
          'INVALID_WORKSPACE_PATH',
          'Workspace path escapes the project root'
        )
      }
      return { absolutePath: current, relativePath }
    }

    const leaf = segments.at(-1)
    if (leaf === undefined) {
      throw new GatewayHttpError(400, 'INVALID_WORKSPACE_PATH', 'Workspace path cannot be empty')
    }
    return { absolutePath: join(current, leaf), relativePath }
  }
}

function normalizeWorkspacePath(input: string): string {
  if (input === '') return ''
  if (input.includes('\0') || posix.isAbsolute(input) || win32.isAbsolute(input)) {
    throw invalidWorkspacePath()
  }
  const segments = input.split(/[\\/]/)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalidWorkspacePath()
  }
  return segments.join('/')
}

function invalidWorkspacePath(): GatewayHttpError {
  return new GatewayHttpError(
    400,
    'INVALID_WORKSPACE_PATH',
    'Workspace path must be a canonical project-relative path'
  )
}

async function resolveEntryKind(
  parent: string,
  entry: Dirent<string>
): Promise<WorkspaceFileKind> {
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  if (entry.isFile()) return 'file'
  try {
    const stats = await lstat(join(parent, entry.name))
    if (stats.isDirectory()) return 'directory'
    if (stats.isSymbolicLink()) return 'symlink'
    return 'file'
  } catch (error) {
    throw mapFileError(error, true)
  }
}

function compareNodes(
  left: WorkspaceDirectoryResponse['entries'][number],
  right: WorkspaceDirectoryResponse['entries'][number]
): number {
  const rank = (kind: WorkspaceFileKind): number =>
    kind === 'directory' ? 0 : kind === 'symlink' ? 1 : 2
  return rank(left.kind) - rank(right.kind) || left.name.localeCompare(right.name)
}

function mapFileError(error: unknown, childPath: boolean): GatewayHttpError {
  if (hasCode(error, 'ENOENT')) {
    return new GatewayHttpError(
      childPath ? 404 : 422,
      childPath ? 'FILE_NOT_FOUND' : 'PROJECT_UNAVAILABLE',
      childPath ? 'Workspace path was not found' : 'Project path is unavailable'
    )
  }
  if (hasCode(error, 'EEXIST')) {
    return new GatewayHttpError(409, 'PATH_EXISTS', 'Workspace path already exists')
  }
  if (hasCode(error, 'EISDIR')) {
    return new GatewayHttpError(422, 'NOT_A_FILE', 'Workspace path is a directory')
  }
  if (hasCode(error, 'ENOTDIR')) {
    return new GatewayHttpError(422, 'NOT_A_DIRECTORY', 'Workspace path is not a directory')
  }
  if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EXDEV')) {
    return new GatewayHttpError(422, 'INVALID_MOVE_TARGET', 'Workspace path cannot be moved')
  }
  if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM')) {
    return new GatewayHttpError(422, 'PROJECT_UNAVAILABLE', 'Workspace path is not accessible')
  }
  return new GatewayHttpError(500, 'INTERNAL_ERROR', 'Workspace file operation failed')
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
