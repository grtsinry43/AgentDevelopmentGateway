import {
  createSessionRequestSchema,
  closeSessionRequestSchema,
  forkSessionRequestSchema,
  gatewayIdSchema,
  interruptSessionRequestSchema,
  resolveInteractionRequestSchema,
  resumeSessionRequestSchema,
  sendSessionInputRequestSchema,
  setExecutionSettingsRequestSchema,
  setSessionModelRequestSchema,
  setSessionTitleRequestSchema,
  setWorkModeRequestSchema,
  sessionEventsQuerySchema
} from '@agent-gateway/shared'
import { ipcMain } from 'electron'
import { IPC } from '../../contract/bridge.js'
import { gatewayServer, resolveServerProject } from '../server/gateway.js'
import { sessionStreams } from '../server/session-streams.js'
import { broadcast } from './broadcast.js'

export function registerSessionHandlers(): void {
  ipcMain.handle(IPC.sessionsList, async (_event, rawProjectKey: unknown) => {
    const projectKey = parseProjectKey(rawProjectKey)
    const resolved = await resolveServerProject(projectKey)
    return gatewayServer.sessions(resolved.serverProjectId)
  })

  ipcMain.handle(IPC.sessionsAdapters, async (_event, rawProjectKey: unknown) => {
    const projectKey = parseProjectKey(rawProjectKey)
    const resolved = await resolveServerProject(projectKey)
    return gatewayServer.adapters(resolved.serverProjectId)
  })

  ipcMain.handle(
    IPC.sessionsCreate,
    async (_event, rawProjectKey: unknown, rawInput: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const input = createSessionRequestSchema.parse(rawInput)
      const resolved = await resolveServerProject(projectKey)
      const created = await gatewayServer.createSession(resolved.serverProjectId, input)
      void refreshSessions(resolved.recent.key, resolved.serverProjectId)
      return created
    }
  )

  ipcMain.handle(IPC.sessionsSend, async (_event, rawSessionId: unknown, rawInput: unknown) => {
    const sessionId = gatewayIdSchema.parse(rawSessionId)
    const input = sendSessionInputRequestSchema.parse(rawInput)
    return gatewayServer.sendInput(sessionId, input)
  })

  ipcMain.handle(IPC.sessionsGet, (_event, rawSessionId: unknown) =>
    gatewayServer.session(gatewayIdSchema.parse(rawSessionId))
  )

  ipcMain.handle(
    IPC.sessionsInterrupt,
    (_event, rawSessionId: unknown, rawInput: unknown = {}) =>
      gatewayServer.interruptSession(
        gatewayIdSchema.parse(rawSessionId),
        interruptSessionRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsResolveInteraction,
    (_event, rawSessionId: unknown, rawInteractionId: unknown, rawInput: unknown) =>
      gatewayServer.resolveInteraction(
        gatewayIdSchema.parse(rawSessionId),
        gatewayIdSchema.parse(rawInteractionId),
        resolveInteractionRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsClose,
    (_event, rawSessionId: unknown, rawInput: unknown = {}) =>
      gatewayServer.closeSession(
        gatewayIdSchema.parse(rawSessionId),
        closeSessionRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsResume,
    (_event, rawSessionId: unknown, rawInput: unknown = {}) =>
      gatewayServer.resumeSession(
        gatewayIdSchema.parse(rawSessionId),
        resumeSessionRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsFork,
    (_event, rawSessionId: unknown, rawInput: unknown = {}) =>
      gatewayServer.forkSession(
        gatewayIdSchema.parse(rawSessionId),
        forkSessionRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsSetTitle,
    (_event, rawSessionId: unknown, rawInput: unknown) =>
      gatewayServer.setSessionTitle(
        gatewayIdSchema.parse(rawSessionId),
        setSessionTitleRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsSetModel,
    (_event, rawSessionId: unknown, rawInput: unknown) =>
      gatewayServer.setSessionModel(
        gatewayIdSchema.parse(rawSessionId),
        setSessionModelRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsSetWorkMode,
    (_event, rawSessionId: unknown, rawInput: unknown) =>
      gatewayServer.setWorkMode(
        gatewayIdSchema.parse(rawSessionId),
        setWorkModeRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsSetExecution,
    (_event, rawSessionId: unknown, rawInput: unknown) =>
      gatewayServer.setExecutionSettings(
        gatewayIdSchema.parse(rawSessionId),
        setExecutionSettingsRequestSchema.parse(rawInput)
      )
  )

  ipcMain.handle(
    IPC.sessionsWatch,
    (event, rawSessionId: unknown, rawAfterSequence: unknown = 0) => {
      const sessionId = gatewayIdSchema.parse(rawSessionId)
      const { after } = sessionEventsQuerySchema.parse({ after: rawAfterSequence })
      sessionStreams.watch(event.sender, sessionId, after)
    }
  )

  ipcMain.handle(IPC.sessionsUnwatch, (event, rawSessionId: unknown) => {
    const sessionId = gatewayIdSchema.parse(rawSessionId)
    sessionStreams.unwatch(event.sender, sessionId)
  })
}

function parseProjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('无效的工程标识')
  return value
}

async function refreshSessions(projectKey: string, serverProjectId: string): Promise<void> {
  try {
    const sessions = await gatewayServer.sessions(serverProjectId)
    broadcast({ kind: 'sessions.changed', projectKey, sessions })
  } catch (error) {
    console.error('[sessions] 创建成功，但刷新 Session 列表失败:', error)
  }
}
