/**
 * remote 模块的 electron 胶水层:
 *  - 本地 server 产物清单(manifest.json)→ RemoteArtifactSource
 *  - HostProfile + 密码 → SshEndpoint
 *  - provision 阶段 → remote.progress 广播
 * 连接本身的生命周期在 electron-free 的 manager.ts。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ServerStatus } from '@agent-gateway/shared'
import { app } from 'electron'
import { z } from 'zod'
import type { HostDetailData, PortForwardWire, RemoteStatus } from '../../contract/bridge.js'
import type { HostProfile } from '../../contract/hosts.js'
import { broadcast } from '../ipc/broadcast.js'
import { getHostPassword, getHostProfile } from '../store/host-profiles.js'
import { GatewayServerClient } from '../server/client.js'
import { RemoteConnectionManager, type RemoteArtifactSource } from './manager.js'
import {
  clearServerInstall,
  ensureMaster,
  isServerRunning,
  probeReachable,
  readInstalledServerVersion,
  startRemoteLogStream,
  stopServer,
  type SshEndpoint
} from './ssh.js'

const packageManifestSchema = z.object({
  version: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  artifacts: z.array(
    z.object({
      target: z.string().min(1),
      file: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/)
    })
  )
})

/**
 * 本地 server 产物目录。
 *
 * electron-vite 5.x 的 startElectron 以 `electron .` 启动(cwd = 工程根 apps/desktop),
 * 所以 app.getAppPath() = apps/desktop。server 产物在 apps/server/out/package:
 * apps/desktop → .. = apps → server/out/package。
 *
 * 打包后的应用没有仓库旁支:优先 AGENT_GATEWAY_SERVER_PACKAGE_DIR 显式指向分发位置,
 * 否则用内嵌的 Resources/server-packages(electron-builder extraResources)。
 */
function packageDirectory(): string {
  if (process.env.AGENT_GATEWAY_SERVER_PACKAGE_DIR) {
    return process.env.AGENT_GATEWAY_SERVER_PACKAGE_DIR
  }
  if (app.isPackaged) return join(process.resourcesPath, 'server-packages')
  return resolve(app.getAppPath(), '../server/out/package')
}

export function loadArtifactSource(): RemoteArtifactSource {
  const directory = packageDirectory()
  const manifestPath = join(directory, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `找不到 server 产物清单: ${manifestPath}\n请先在仓库根运行: pnpm package -- --target <目标平台>`
    )
  }
  let parsed: z.infer<typeof packageManifestSchema>
  try {
    parsed = packageManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch {
    throw new Error(`server 产物清单格式非法: ${manifestPath}`)
  }
  return {
    version: parsed.version,
    protocolVersion: parsed.protocolVersion,
    artifacts: Object.fromEntries(
      parsed.artifacts.map((artifact) => [
        artifact.target,
        { file: artifact.file, sha256: artifact.sha256, localPath: join(directory, artifact.file) }
      ])
    )
  }
}

const socketDir = `/tmp/agw-ssh-${process.getuid?.() ?? process.pid}`
const sshContext = { socketDir, askpassPath: join(app.getPath('userData'), 'ssh-askpass.sh') }

let manager: RemoteConnectionManager | undefined

function getManager(): RemoteConnectionManager {
  if (!manager) {
    manager = new RemoteConnectionManager(
      sshContext,
      loadArtifactSource(),
      (profileId, stage, message) =>
        broadcast({ kind: 'remote.progress', hostProfileId: profileId, stage, ...(message ? { message } : {}) }),
      (profileId, state, message) =>
        broadcast({
          kind: 'remote.state',
          hostProfileId: profileId,
          state,
          ...(message ? { message } : {})
        }),
      (profileId) =>
        broadcast({
          kind: 'ports.changed',
          hostProfileId: profileId,
          forwards: manager?.listForwards(profileId) ?? []
        })
    )
  }
  return manager
}

/** HostProfile(+存储的密码)→ SSH 连接参数。 */
export async function endpointForProfile(profile: HostProfile): Promise<SshEndpoint> {
  const endpoint: SshEndpoint = {
    username: profile.username,
    hostname: profile.hostname,
    port: profile.port
  }
  if (profile.auth === 'key') {
    if (!profile.keyPath) throw new Error(`主机 ${profile.name} 未配置私钥`)
    endpoint.keyPath = profile.keyPath
  } else {
    const password = await getHostPassword(profile.id)
    if (!password) {
      throw new Error(`主机 ${profile.name} 没有可用的密码(未保存或已过期),请重新编辑主机并输入`)
    }
    endpoint.password = password
  }
  return endpoint
}

/** 建立(或复用)到某主机的远程 server 连接。 */
export function ensureRemoteConnection(profile: HostProfile) {
  return endpointForProfile(profile).then((endpoint) =>
    getManager().ensure(profile.id, endpoint)
  )
}

/** Web 预览中转:把远端 localhost:<remotePort> 转发到本地,返回本地端口。 */
export async function openPreviewTunnel(hostProfileId: string, remotePort: number): Promise<number> {
  const profile = await getHostProfile(hostProfileId)
  if (!profile) throw new Error('主机配置不存在或已被删除')
  const endpoint = await endpointForProfile(profile)
  return getManager().openForward(profile.id, endpoint, remotePort, 'preview')
}

/** 某主机的活动端口转发(不会触发连接)。 */
export function listPortForwards(hostProfileId: string): PortForwardWire[] {
  return getManager().listForwards(hostProfileId)
}

/** 手动绑定:远端端口 → 本地。返回转发信息(广播会推给所有窗口)。 */
export async function bindPortForward(
  profile: HostProfile,
  remotePort: number
): Promise<PortForwardWire> {
  const endpoint = await endpointForProfile(profile)
  const localPort = await getManager().openForward(profile.id, endpoint, remotePort, 'manual')
  return { hostProfileId: profile.id, remotePort, localPort, origin: 'manual' }
}

/** 关闭一条转发(不存在则忽略)。 */
export function closePortForward(profile: HostProfile, remotePort: number): void {
  getManager().closeForward(profile.id, remotePort)
}

/**
 * 远程连接状态查询。**不触发连接**:只读当前状态与已建立连接的资源快照,
 * 让标题栏能如实显示「已断开」而不是偷偷重连。
 */
export async function remoteStatusForProfile(profile: HostProfile): Promise<RemoteStatus> {
  const manager = getManager()
  const { state, message } = manager.getState(profile.id)
  const result: RemoteStatus = {
    isRemote: true,
    hostProfileId: profile.id,
    hostname: profile.hostname,
    username: profile.username,
    state,
    ...(message ? { stateMessage: message } : {})
  }
  const connection = manager.getInfo(profile.id)
  if (!connection) return result

  result.hostId = connection.hostId
  try {
    const client = new GatewayServerClient(connection.baseUrl, connection.token)
    const [serverInfo, status] = await Promise.all([
      client.serverInfo(),
      client.serverStatus()
    ])
    result.serverVersion = serverInfo.version
    result.protocolVersion = serverInfo.protocolVersion
    result.status = status as ServerStatus
  } catch (error) {
    result.stateMessage = error instanceof Error ? error.message : String(error)
  }
  return result
}

/** 断开并重新建立连接(重连)。 */
export async function reconnectRemote(profile: HostProfile): Promise<void> {
  const manager = getManager()
  const endpoint = await endpointForProfile(profile)
  await manager.release(profile.id)
  await manager.ensure(profile.id, endpoint)
}

/** 断开本地隧道;远程 server 继续运行。 */
export async function disconnectRemote(profile: HostProfile): Promise<void> {
  await getManager().release(profile.id)
}

/** 应用退出时收掉全部隧道与控制连接(不动远程 server)。 */
export async function closeAllRemoteConnections(profiles: HostProfile[]): Promise<void> {
  for (const profile of profiles) stopRemoteLog(profile)
  if (!manager) return
  const endpoints = new Map<string, SshEndpoint>()
  for (const profile of profiles) {
    try {
      endpoints.set(profile.id, await endpointForProfile(profile))
    } catch {
      // 密码缺失的主机本来也建不了 master,跳过即可。
    }
  }
  await manager.closeAll(endpoints)
}

// ── 远程日志串流 ─────────────────────────────────────────────────────────

const LOG_PATH = '~/.agent-development-gateway/server/server.log'
const MAX_LOG_BUFFER = 1_000
const logStreams = new Map<string, { handle: import('./ssh.js').LogStreamHandle; buffer: string[] }>()
let logFlushTimer: ReturnType<typeof setInterval> | undefined

function scheduleLogFlush(): void {
  if (logFlushTimer) return
  logFlushTimer = setInterval(() => {
    for (const [profileId, entry] of logStreams) {
      if (entry.buffer.length === 0) continue
      const lines = entry.buffer.splice(0)
      broadcast({ kind: 'remote.log', hostProfileId: profileId, lines })
    }
  }, 250)
}

/** 开始串流远程 server 日志(依赖 ControlMaster,不重新认证)。 */
export async function startRemoteLog(profile: HostProfile): Promise<void> {
  if (logStreams.has(profile.id)) return
  const endpoint = await endpointForProfile(profile)
  await ensureMaster(sshContext, endpoint)
  const buffer: string[] = []
  const handle = startRemoteLogStream(sshContext, endpoint, LOG_PATH, (line) => {
    buffer.push(line)
    if (buffer.length >= MAX_LOG_BUFFER) {
      broadcast({ kind: 'remote.log', hostProfileId: profile.id, lines: buffer.splice(0) })
    }
  })
  logStreams.set(profile.id, { handle, buffer })
  scheduleLogFlush()
  broadcast({ kind: 'remote.logState', hostProfileId: profile.id, streaming: true })
}

/** 停止串流远程日志。 */
export function stopRemoteLog(profile: HostProfile): void {
  const entry = logStreams.get(profile.id)
  if (!entry) return
  logStreams.delete(profile.id)
  entry.handle.close()
  broadcast({ kind: 'remote.logState', hostProfileId: profile.id, streaming: false })
}

// ── 主机在线探测 / 停止 server(Launcher)────────────────────────────────

/** 探测所有主机的 SSH 可达性与 Gateway Server 运行状态。 */
export async function probeHosts(profiles: HostProfile[]) {
  const results = await Promise.all(
    profiles.map(async (profile) => {
      try {
        const endpoint = await endpointForProfile(profile)
        const sshReachable = await probeReachable(sshContext, endpoint)
        if (!sshReachable) return { hostProfileId: profile.id, sshReachable: false, serverRunning: false }
        const serverRunning = await isServerRunning(sshContext, endpoint)
        return { hostProfileId: profile.id, sshReachable: true, serverRunning }
      } catch {
        return { hostProfileId: profile.id, sshReachable: false, serverRunning: false }
      }
    })
  )
  broadcast({ kind: 'remote.hostsProbed', hosts: results })
  return results
}

/** 优雅停止远程 Gateway Server。 */
export async function stopServerForProfile(profile: HostProfile): Promise<void> {
  stopRemoteLog(profile)
  await getManager().release(profile.id)
  const endpoint = await endpointForProfile(profile)
  await stopServer(sshContext, endpoint)
  broadcast({ kind: 'remote.state', hostProfileId: profile.id, state: 'disconnected' })
}

// ── 主机详情 / 后端管理(Launcher 管理中心)────────────────────────────

/** 主机详情:连接状态 + 已安装版本 + 连接时的资源快照。不触发连接。 */
export async function hostDetailForProfile(profile: HostProfile) {
  const manager = getManager()
  const { state, message } = manager.getState(profile.id)
  const result: HostDetailData = {
    profile,
    state,
    ...(message ? { stateMessage: message } : {})
  }
  try {
    const installed = await readInstalledServerVersion(sshContext, await endpointForProfile(profile))
    if (installed) {
      result.installedVersion = installed.version
      result.installedProtocol = installed.protocolVersion
    }
  } catch {
    // 主机不可达时读不到安装信息,保留已装的展示为空。
  }
  const connection = manager.getInfo(profile.id)
  if (!connection) return result

  try {
    const client = new GatewayServerClient(connection.baseUrl, connection.token)
    const [serverInfo, status] = await Promise.all([
      client.serverInfo(),
      client.serverStatus()
    ])
    result.connectedVersion = serverInfo.version
    result.protocolVersion = serverInfo.protocolVersion
    result.status = status
  } catch (error) {
    result.stateMessage = error instanceof Error ? error.message : String(error)
  }
  return result
}

/** 启动(或复用)后端:确保已安装并运行。 */
export async function startHost(profile: HostProfile): Promise<void> {
  await ensureRemoteConnection(profile)
}

/** 重启后端:停止后重新建立连接(不重新安装)。 */
export async function restartHost(profile: HostProfile): Promise<void> {
  stopRemoteLog(profile)
  const manager = getManager()
  await manager.release(profile.id)
  const endpoint = await endpointForProfile(profile)
  await stopServer(sshContext, endpoint)
  await manager.ensure(profile.id, endpoint)
}

/** 重装后端:清掉远端安装并强制重新上传当前版本。 */
export async function reinstallHost(profile: HostProfile): Promise<void> {
  stopRemoteLog(profile)
  const manager = getManager()
  await manager.release(profile.id)
  const endpoint = await endpointForProfile(profile)
  await stopServer(sshContext, endpoint)
  await clearServerInstall(sshContext, endpoint)
  await manager.ensure(profile.id, endpoint)
}
