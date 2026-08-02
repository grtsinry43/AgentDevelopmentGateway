import { workspaceFileSubscriptionSchema, workspaceRelativePathSchema } from '@agent-gateway/shared'
import { ipcMain } from 'electron'
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

function parseProjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('无效的工程标识')
  return value
}
