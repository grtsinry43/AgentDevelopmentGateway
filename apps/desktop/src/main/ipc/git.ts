import {
  gitCommitRequestSchema,
  gitDiffQuerySchema,
  gitPathsRequestSchema
} from '@agent-gateway/shared'
import { ipcMain } from 'electron'
import { IPC } from '../../contract/bridge.js'
import { gitStreams } from '../server/git-streams.js'
import { GatewayServerError } from '../server/client.js'
import { resolveServerProject } from '../server/gateway.js'

export function registerGitHandlers(): void {
  ipcMain.handle(IPC.gitCapabilities, async (_event, rawProjectKey: unknown) => {
    const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
    return (await resolved.client.serverInfo()).capabilities.filter((capability) =>
      capability.startsWith('workspace.git.')
    )
  })

  ipcMain.handle(IPC.gitStatus, async (_event, rawProjectKey: unknown) => {
    const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
    try {
      return { available: true, state: await resolved.client.gitStatus(resolved.serverProjectId) }
    } catch (error) {
      if (error instanceof GatewayServerError && error.code === 'GIT_NOT_REPOSITORY') {
        return { available: false, reason: 'not-repository', message: error.message }
      }
      if (error instanceof GatewayServerError && error.code === 'GIT_UNAVAILABLE') {
        return { available: false, reason: 'git-unavailable', message: error.message }
      }
      throw error
    }
  })

  ipcMain.handle(
    IPC.gitDiff,
    async (_event, rawProjectKey: unknown, rawPath: unknown, rawArea: unknown) => {
      const input = gitDiffQuerySchema.parse({ path: rawPath, area: rawArea })
      const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
      return resolved.client.gitDiff(resolved.serverProjectId, input.path, input.area)
    }
  )

  ipcMain.handle(IPC.gitStage, async (_event, rawProjectKey: unknown, rawPaths: unknown) => {
    const input = gitPathsRequestSchema.parse({ paths: rawPaths })
    const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
    await resolved.client.stageGit(resolved.serverProjectId, input.paths)
  })

  ipcMain.handle(IPC.gitUnstage, async (_event, rawProjectKey: unknown, rawPaths: unknown) => {
    const input = gitPathsRequestSchema.parse({ paths: rawPaths })
    const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
    await resolved.client.unstageGit(resolved.serverProjectId, input.paths)
  })

  ipcMain.handle(IPC.gitCommit, async (_event, rawProjectKey: unknown, rawMessage: unknown) => {
    const input = gitCommitRequestSchema.parse({ message: rawMessage })
    const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
    return resolved.client.commitGit(resolved.serverProjectId, input.message)
  })

  ipcMain.handle(IPC.gitWatch, async (event, rawProjectKey: unknown) => {
    const projectKey = parseProjectKey(rawProjectKey)
    const resolved = await resolveServerProject(projectKey)
    gitStreams.watch(event.sender, resolved.client, resolved.recent.key, resolved.serverProjectId)
  })

  ipcMain.handle(IPC.gitUnwatch, (event, rawProjectKey: unknown) => {
    gitStreams.unwatch(event.sender, parseProjectKey(rawProjectKey))
  })

  ipcMain.handle(IPC.gitRetry, (event, rawProjectKey: unknown) => {
    gitStreams.retry(event.sender, parseProjectKey(rawProjectKey))
  })
}

function parseProjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('无效的工程标识')
  return value
}
