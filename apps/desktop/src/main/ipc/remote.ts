import { ipcMain } from 'electron'
import { IPC, type RemoteStatus } from '../../contract/bridge.js'
import type { HostProfile } from '../../contract/hosts.js'
import { GatewayServerClient } from '../server/client.js'
import {
  disconnectRemote,
  ensureRemoteConnection,
  hostDetailForProfile,
  probeHosts,
  reconnectRemote,
  reinstallHost,
  remoteStatusForProfile,
  restartHost,
  startHost,
  startRemoteLog,
  stopRemoteLog,
  stopServerForProfile
} from '../remote/index.js'
import { getHostProfile, listHostProfiles } from '../store/host-profiles.js'
import { findProject } from '../store/recent-projects.js'

export function registerRemoteHandlers(): void {
  ipcMain.handle(IPC.remoteStatus, async (_event, rawProjectKey: unknown) => {
    const profile = await requireRemoteProfile(parseProjectKey(rawProjectKey))
    if (!profile) return { isRemote: false } as RemoteStatus
    return remoteStatusForProfile(profile)
  })

  ipcMain.handle(IPC.remoteReconnect, async (_event, rawProjectKey: unknown) => {
    const profile = await requireRemoteProfile(parseProjectKey(rawProjectKey))
    if (!profile) return
    await reconnectRemote(profile)
  })

  ipcMain.handle(IPC.remoteDisconnect, async (_event, rawProjectKey: unknown) => {
    const profile = await requireRemoteProfile(parseProjectKey(rawProjectKey))
    if (!profile) return
    await disconnectRemote(profile)
  })

  ipcMain.handle(IPC.remoteLogStart, async (_event, rawHostProfileId: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    await startRemoteLog(profile)
  })

  ipcMain.handle(IPC.remoteLogStop, async (_event, rawHostProfileId: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    stopRemoteLog(profile)
  })

  ipcMain.handle(IPC.remoteProbeHosts, async () => probeHosts(await listHostProfiles()))

  ipcMain.handle(IPC.remoteStopServer, async (_event, rawHostProfileId: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    await stopServerForProfile(profile)
  })

  ipcMain.handle(IPC.remoteHostDetail, async (_event, rawHostProfileId: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    return hostDetailForProfile(profile)
  })

  ipcMain.handle(IPC.remoteHostStart, async (_event, rawHostProfileId: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    await startHost(profile)
  })

  ipcMain.handle(IPC.remoteHostRestart, async (_event, rawHostProfileId: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    await restartHost(profile)
  })

  ipcMain.handle(IPC.remoteHostReinstall, async (_event, rawHostProfileId: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    await reinstallHost(profile)
  })

  ipcMain.handle(IPC.remoteBrowseDirectory, async (_event, rawHostProfileId: unknown, rawPath: unknown) => {
    const profile = await requireHostProfile(rawHostProfileId)
    if (typeof rawPath !== 'string' || rawPath.length === 0) throw new Error('无效的路径')
    const connection = await ensureRemoteConnection(profile)
    const client = new GatewayServerClient(connection.baseUrl, connection.token)
    return client.hostDirectory(rawPath)
  })
}

async function requireHostProfile(rawHostProfileId: unknown): Promise<HostProfile> {
  if (typeof rawHostProfileId !== 'string') throw new Error('无效的主机标识')
  const profile = await getHostProfile(rawHostProfileId)
  if (!profile) throw new Error('主机配置已被删除')
  return profile
}

/** 解析 projectKey → HostProfile;本地工程或主机被删返回 undefined。 */
async function requireRemoteProfile(projectKey: string): Promise<HostProfile | undefined> {
  const recent = await findProject(projectKey)
  if (!recent || recent.hostType !== 'ssh' || !recent.hostProfileId) return undefined
  return getHostProfile(recent.hostProfileId)
}

function parseProjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('无效的工程标识')
  return value
}
