import {
  workspaceFileCreateRequestSchema,
  workspaceFileMoveRequestSchema,
  workspaceFileSubscriptionSchema,
  workspaceFileWriteRequestSchema,
  workspaceRelativePathSchema
} from '@agent-gateway/shared'
import type { WorkspaceFileKind } from '@agent-gateway/shared'
import { app, clipboard, ipcMain, shell } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from 'extract-zip'
import { IPC } from '../../contract/bridge.js'
import { fileStreams } from '../server/file-streams.js'
import { resolveServerProject } from '../server/gateway.js'

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.filesCapabilities, async (_event, rawProjectKey: unknown) => {
    const projectKey = parseProjectKey(rawProjectKey)
    const resolved = await resolveServerProject(projectKey)
    return (await resolved.client.serverInfo()).capabilities.filter((capability) =>
      capability.startsWith('workspace.files.')
    )
  })

  ipcMain.handle(
    IPC.filesList,
    async (_event, rawProjectKey: unknown, rawPath: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const path = workspaceRelativePathSchema.parse(rawPath)
      const resolved = await resolveServerProject(projectKey)
      return resolved.client.workspaceDirectory(resolved.serverProjectId, path)
    }
  )

  ipcMain.handle(
    IPC.filesRead,
    async (_event, rawProjectKey: unknown, rawPath: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const path = workspaceRelativePathSchema.parse(rawPath)
      if (path.length === 0) throw new Error('无效的文件路径')
      const resolved = await resolveServerProject(projectKey)
      return resolved.client.workspaceFileContent(resolved.serverProjectId, path)
    }
  )

  ipcMain.handle(
    IPC.filesCreate,
    async (_event, rawProjectKey: unknown, rawInput: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const input = workspaceFileCreateRequestSchema.parse(rawInput)
      const resolved = await resolveServerProject(projectKey)
      await resolved.client.createWorkspaceFile(resolved.serverProjectId, input)
    }
  )

  ipcMain.handle(
    IPC.filesRename,
    async (_event, rawProjectKey: unknown, rawInput: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const input = workspaceFileMoveRequestSchema.parse(rawInput)
      const resolved = await resolveServerProject(projectKey)
      await resolved.client.moveWorkspaceFile(resolved.serverProjectId, input)
    }
  )

  ipcMain.handle(
    IPC.filesDelete,
    async (_event, rawProjectKey: unknown, rawPath: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const path = workspaceRelativePathSchema.parse(rawPath)
      if (path.length === 0) throw new Error('无效的文件路径')
      const resolved = await resolveServerProject(projectKey)
      await resolved.client.deleteWorkspaceFile(resolved.serverProjectId, path)
    }
  )

  ipcMain.handle(
    IPC.filesWrite,
    async (_event, rawProjectKey: unknown, rawPath: unknown, rawContent: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const input = workspaceFileWriteRequestSchema.parse({
        path: rawPath,
        content: rawContent
      })
      const resolved = await resolveServerProject(projectKey)
      await resolved.client.writeWorkspaceFile(resolved.serverProjectId, input)
    }
  )

  ipcMain.handle(
    IPC.filesCopy,
    async (_event, rawProjectKey: unknown, rawInput: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const input = workspaceFileMoveRequestSchema.parse(rawInput)
      const resolved = await resolveServerProject(projectKey)
      await resolved.client.copyWorkspaceFile(resolved.serverProjectId, input)
    }
  )

  ipcMain.handle(
    IPC.filesCopyPath,
    async (_event, rawProjectKey: unknown, rawPath: unknown, rawMode: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const path = workspaceRelativePathSchema.parse(rawPath)
      const resolved = await resolveServerProject(projectKey)
      const text = rawMode === 'absolute' ? join(resolved.recent.path, path) : path
      clipboard.writeText(text)
    }
  )

  ipcMain.handle(
    IPC.filesReveal,
    async (_event, rawProjectKey: unknown, rawPath: unknown, rawKind: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const path = workspaceRelativePathSchema.parse(rawPath)
      const kind: WorkspaceFileKind =
        rawKind === 'directory' ? 'directory' : rawKind === 'symlink' ? 'symlink' : 'file'
      const resolved = await resolveServerProject(projectKey)
      return revealOrDownload(resolved, path, kind)
    }
  )

  ipcMain.handle(
    IPC.filesWatch,
    async (event, rawProjectKey: unknown, rawDirectories: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const { directories } = workspaceFileSubscriptionSchema.parse({ directories: rawDirectories })
      const resolved = await resolveServerProject(projectKey)
      fileStreams.watch(
        event.sender,
        resolved.client,
        resolved.recent.key,
        resolved.serverProjectId,
        directories
      )
    }
  )

  ipcMain.handle(
    IPC.filesUpdateWatch,
    (event, rawProjectKey: unknown, rawDirectories: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const { directories } = workspaceFileSubscriptionSchema.parse({ directories: rawDirectories })
      return fileStreams.update(event.sender, projectKey, directories)
    }
  )

  ipcMain.handle(IPC.filesUnwatch, (event, rawProjectKey: unknown) => {
    fileStreams.unwatch(event.sender, parseProjectKey(rawProjectKey))
  })

  ipcMain.handle(IPC.filesRetry, (event, rawProjectKey: unknown) => {
    fileStreams.retry(event.sender, parseProjectKey(rawProjectKey))
  })
}

/**
 * 本地:在系统文件管理器中显示,返回 null。
 * 远程:下载/解包到下载目录的镜像子目录(不打开文件管理器),返回本地路径。
 */
async function revealOrDownload(
  resolved: Awaited<ReturnType<typeof resolveServerProject>>,
  path: string,
  kind: WorkspaceFileKind
): Promise<string | null> {
  if (resolved.recent.hostType !== 'ssh') {
    shell.showItemInFolder(join(resolved.recent.path, path))
    return null
  }

  const projectName = sanitizePathSegment(resolved.recent.name || 'remote-project')
  const mirrorRoot = join(app.getPath('downloads'), 'Agent Development Gateway', projectName)
  const target = join(mirrorRoot, path)
  await mkdir(join(target, '..'), { recursive: true })

  const response = await resolved.client.downloadWorkspaceFile(resolved.serverProjectId, path)
  if (!response.ok || !response.body) throw new Error('远程文件下载失败')

  if (kind === 'directory') {
    const archivePath = join(mirrorRoot, `.download-${Date.now()}.zip`)
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(archivePath)
      )
      await rm(target, { recursive: true, force: true })
      await mkdir(target, { recursive: true })
      await extract(archivePath, { dir: target })
    } finally {
      await rm(archivePath, { force: true })
    }
  } else {
    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(target)
    )
  }
  return target
}

function sanitizePathSegment(value: string): string {
  const withoutControl = Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
  const cleaned = withoutControl.replace(/[\\/:*?"<>|]/g, '-').replace(/\.+$/g, '')
  return (cleaned.trim() || 'remote-project').slice(0, 120)
}

function parseProjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('无效的工程标识')
  return value
}
