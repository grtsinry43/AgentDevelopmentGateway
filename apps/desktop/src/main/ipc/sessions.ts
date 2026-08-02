import {
  adapterIdSchema,
  createSessionRequestSchema,
  closeSessionRequestSchema,
  forkSessionRequestSchema,
  gatewayIdSchema,
  interruptSessionRequestSchema,
  listModelsQuerySchema,
  reorderQueuedInputsRequestSchema,
  replaceQueuedInputRequestSchema,
  resolveInteractionRequestSchema,
  resumeSessionRequestSchema,
  sendSessionInputRequestSchema,
  setExecutionSettingsRequestSchema,
  setSessionModelRequestSchema,
  setSessionTitleRequestSchema,
  setWorkModeRequestSchema,
  sessionEventsQuerySchema,
  eventsHistoryQuerySchema,
  sessionItemsQuerySchema
} from '@agent-gateway/shared'
import type { GatewayAdapterId, ProviderRuntimeConfigWire } from '@agent-gateway/shared'
import { ipcMain } from 'electron'
import { IPC } from '../../contract/bridge.js'
import { resolveForSender, resolveServerProject } from '../server/gateway.js'
import type { GatewayServerClient } from '../server/client.js'
import { getProviderApiKey, getProviderProfile } from '../store/provider-profiles.js'
import { sessionStreams } from '../server/session-streams.js'
import { broadcast } from './broadcast.js'

export function registerSessionHandlers(): void {
  ipcMain.handle(IPC.sessionsList, async (_event, rawProjectKey: unknown) => {
    const projectKey = parseProjectKey(rawProjectKey)
    const resolved = await resolveServerProject(projectKey)
    return resolved.client.sessions(resolved.serverProjectId)
  })

  ipcMain.handle(IPC.sessionsAdapters, async (_event, rawProjectKey: unknown) => {
    const projectKey = parseProjectKey(rawProjectKey)
    const resolved = await resolveServerProject(projectKey)
    return resolved.client.adapters(resolved.serverProjectId)
  })

  ipcMain.handle(
    IPC.sessionsModels,
    async (
      _event,
      rawProjectKey: unknown,
      rawAdapterId: unknown,
      rawQuery: unknown = {}
    ) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const adapterId = adapterIdSchema.parse(rawAdapterId)
      const query = listModelsQuerySchema.parse(rawQuery)
      const resolved = await resolveServerProject(projectKey)
      return resolved.client.projectModels(resolved.serverProjectId, adapterId, query)
    }
  )

  ipcMain.handle(IPC.sessionsSessionModels, async (event, rawSessionId: unknown) => {
    const { client } = await resolveForSender(event.sender)
    return client.sessionModels(gatewayIdSchema.parse(rawSessionId))
  })

  ipcMain.handle(
    IPC.sessionsCreate,
    async (_event, rawProjectKey: unknown, rawInput: unknown) => {
      const projectKey = parseProjectKey(rawProjectKey)
      const input = createSessionRequestSchema.parse(rawInput)
      const resolved = await resolveServerProject(projectKey)
      const providerConfig = await resolveProviderConfig(input.providerProfileId, input.adapterId)
      const created = await resolved.client.createSession(resolved.serverProjectId, {
        ...input,
        ...(providerConfig ? { providerConfig } : {}),
      })
      void refreshSessions(resolved.recent.key, resolved.serverProjectId, resolved.client)
      return created
    }
  )

  ipcMain.handle(IPC.sessionsSend, async (event, rawSessionId: unknown, rawInput: unknown) => {
    const sessionId = gatewayIdSchema.parse(rawSessionId)
    const input = sendSessionInputRequestSchema.parse(rawInput)
    const { client } = await resolveForSender(event.sender)
    return client.sendInput(sessionId, input)
  })

  ipcMain.handle(
    IPC.sessionsQueueReplace,
    async (event, rawSessionId: unknown, rawInputId: unknown, rawInput: unknown) => {
      const { client } = await resolveForSender(event.sender)
      return client.replaceQueuedInput(
        gatewayIdSchema.parse(rawSessionId),
        gatewayIdSchema.parse(rawInputId),
        replaceQueuedInputRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(IPC.sessionsQueueReorder, async (event, rawSessionId: unknown, rawInput: unknown) => {
    const { client } = await resolveForSender(event.sender)
    return client.reorderQueuedInputs(
      gatewayIdSchema.parse(rawSessionId),
      reorderQueuedInputsRequestSchema.parse(rawInput)
    )
  })

  ipcMain.handle(IPC.sessionsQueueCancel, async (event, rawSessionId: unknown, rawInputId: unknown) => {
    const { client } = await resolveForSender(event.sender)
    return client.cancelQueuedInput(
      gatewayIdSchema.parse(rawSessionId),
      gatewayIdSchema.parse(rawInputId)
    )
  })

  ipcMain.handle(IPC.sessionsQueueSendNow, async (event, rawSessionId: unknown, rawInputId: unknown) => {
    const { client } = await resolveForSender(event.sender)
    return client.sendQueuedInputNow(
      gatewayIdSchema.parse(rawSessionId),
      gatewayIdSchema.parse(rawInputId)
    )
  })

  ipcMain.handle(IPC.sessionsGet, async (event, rawSessionId: unknown) => {
    const { client } = await resolveForSender(event.sender)
    return client.session(gatewayIdSchema.parse(rawSessionId))
  })

  ipcMain.handle(
    IPC.sessionsInterrupt,
    async (event, rawSessionId: unknown, rawInput: unknown = {}) => {
      const { client } = await resolveForSender(event.sender)
      return client.interruptSession(
        gatewayIdSchema.parse(rawSessionId),
        interruptSessionRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(
    IPC.sessionsResolveInteraction,
    async (event, rawSessionId: unknown, rawInteractionId: unknown, rawInput: unknown) => {
      const { client } = await resolveForSender(event.sender)
      return client.resolveInteraction(
        gatewayIdSchema.parse(rawSessionId),
        gatewayIdSchema.parse(rawInteractionId),
        resolveInteractionRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(
    IPC.sessionsClose,
    async (event, rawSessionId: unknown, rawInput: unknown = {}) => {
      const { client } = await resolveForSender(event.sender)
      return client.closeSession(
        gatewayIdSchema.parse(rawSessionId),
        closeSessionRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(
    IPC.sessionsResume,
    async (event, rawSessionId: unknown, rawInput: unknown = {}) => {
      const { client } = await resolveForSender(event.sender)
      const input = resumeSessionRequestSchema.parse(rawInput)
      const providerConfig = await resolveProviderConfig(input.providerProfileId)
      return client.resumeSession(gatewayIdSchema.parse(rawSessionId), {
        ...input,
        ...(providerConfig ? { providerConfig } : {}),
      })
    }
  )

  ipcMain.handle(
    IPC.sessionsFork,
    async (event, rawSessionId: unknown, rawInput: unknown = {}) => {
      const { client } = await resolveForSender(event.sender)
      return client.forkSession(
        gatewayIdSchema.parse(rawSessionId),
        forkSessionRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(
    IPC.sessionsSetTitle,
    async (event, rawSessionId: unknown, rawInput: unknown) => {
      const { client, recent, serverProjectId } = await resolveForSender(event.sender)
      const result = await client.setSessionTitle(
        gatewayIdSchema.parse(rawSessionId),
        setSessionTitleRequestSchema.parse(rawInput)
      )
      void refreshSessions(recent.key, serverProjectId, client)
      return result
    }
  )

  ipcMain.handle(
    IPC.sessionsSetModel,
    async (event, rawSessionId: unknown, rawInput: unknown) => {
      const { client } = await resolveForSender(event.sender)
      return client.setSessionModel(
        gatewayIdSchema.parse(rawSessionId),
        setSessionModelRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(
    IPC.sessionsSetWorkMode,
    async (event, rawSessionId: unknown, rawInput: unknown) => {
      const { client } = await resolveForSender(event.sender)
      return client.setWorkMode(
        gatewayIdSchema.parse(rawSessionId),
        setWorkModeRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(
    IPC.sessionsSetExecution,
    async (event, rawSessionId: unknown, rawInput: unknown) => {
      const { client } = await resolveForSender(event.sender)
      return client.setExecutionSettings(
        gatewayIdSchema.parse(rawSessionId),
        setExecutionSettingsRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(
    IPC.sessionsWatch,
    async (event, rawSessionId: unknown, rawAfterSequence: unknown = 0) => {
      const sessionId = gatewayIdSchema.parse(rawSessionId)
      const { after } = sessionEventsQuerySchema.parse({ after: rawAfterSequence })
      const { client } = await resolveForSender(event.sender)
      sessionStreams.watch(event.sender, client, sessionId, after)
    }
  )

  ipcMain.handle(
    IPC.sessionsEventsHistory,
    async (event, rawSessionId: unknown, rawBefore: unknown, rawLimit: unknown) => {
      const { before, limit } = eventsHistoryQuerySchema.parse({
        before: rawBefore,
        limit: rawLimit
      })
      const { client } = await resolveForSender(event.sender)
      return client.eventsHistory(gatewayIdSchema.parse(rawSessionId), before, limit)
    }
  )

  ipcMain.handle(
    IPC.sessionsItems,
    async (event, rawSessionId: unknown, rawBefore: unknown, rawLimit: unknown) => {
      const { before, limit } = sessionItemsQuerySchema.parse({
        before: rawBefore,
        limit: rawLimit
      })
      const { client } = await resolveForSender(event.sender)
      return client.sessionItems(gatewayIdSchema.parse(rawSessionId), before, limit)
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

/**
 * 把渲染层选的 providerProfileId 解析成发给 server 的 providerConfig。
 * 明文 key 只在主进程解密,经(本地 loopback / 远程 SSH 隧道)到达 server;server 不落盘。
 * adapterId 不匹配时忽略 profile(防止跨 provider 误用)。
 */
async function resolveProviderConfig(
  providerProfileId: string | undefined,
  adapterId?: GatewayAdapterId
): Promise<ProviderRuntimeConfigWire | undefined> {
  if (!providerProfileId) return undefined
  const profile = await getProviderProfile(providerProfileId)
  if (!profile || !profile.enabled) return undefined
  if (adapterId && profile.adapterId !== adapterId) return undefined
  const apiKey = await getProviderApiKey(profile.id)
  const modelAliases = Object.keys(profile.modelAliases).length
    ? { ...profile.modelAliases }
    : undefined
  const openaiCompatible = profile.openaiCompatible
  if (
    !profile.baseUrl &&
    !apiKey &&
    !modelAliases &&
    openaiCompatible === undefined
  ) {
    return undefined
  }
  return {
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(modelAliases ? { modelAliases } : {}),
    ...(openaiCompatible !== undefined ? { openaiCompatible } : {}),
  }
}

async function refreshSessions(
  projectKey: string,
  serverProjectId: string,
  client: GatewayServerClient
): Promise<void> {
  try {
    const sessions = await client.sessions(serverProjectId)
    broadcast({ kind: 'sessions.changed', projectKey, sessions })
  } catch (error) {
    console.error('[sessions] 创建成功，但刷新 Session 列表失败:', error)
  }
}
