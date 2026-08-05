/**
 * RemoteConnectionManager —— 按主机 memoize 的远程连接生命周期。
 *
 * electron-free:主机资料(SshEndpoint)与产物信息由调用方注入;electron 胶水层
 * (main/remote/index.ts)负责读 HostProfile、解析密码、广播进度。
 *
 * 一个连接 = ControlMaster(认证一次)+ provision(幂等)+ 本地端口转发。
 * 断开只收隧道与控制连接,绝不杀远程 server —— 与 docs/07 §4 的生命周期语义一致。
 */
import type { ConnectionState } from '../../contract/hosts.js'
import type { PortForwardWire } from '../../contract/bridge.js'
import { provision, type ProvisionStage } from './provision.js'
import {
  ensureMaster,
  startTunnel,
  stopMaster,
  type SshContext,
  type SshEndpoint,
  type TunnelHandle
} from './ssh.js'

export interface RemoteArtifactSource {
  version: string
  protocolVersion: number
  /** target → 产物(文件名/sha256/本地路径)。 */
  artifacts: Record<string, { file: string; sha256: string; localPath: string }>
}

export interface RemoteConnectionInfo {
  /** 服务端权威 hostId(server_identity)。 */
  hostId: string
  baseUrl: string
  token?: string
  localPort: number
  remotePort: number
}

interface ActiveConnection {
  info: RemoteConnectionInfo
  tunnel: TunnelHandle
}

export interface ConnectionStateView {
  state: ConnectionState
  message?: string
}

/** 一条活动端口转发:本地 loopback 转发到远端 localhost 端口。 */
interface ForwardEntry {
  tunnel: TunnelHandle
  origin: 'preview' | 'manual'
}

/** 经隧道请求 /health,判断远程 server 是否真的活着。loopback 转发,毫秒级。 */
async function isConnectionAlive(connection: ActiveConnection): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    const response = await fetch(`${connection.info.baseUrl}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

export class RemoteConnectionManager {
  private readonly connections = new Map<string, Promise<ActiveConnection>>()
  /** 已建立的连接信息;与 connections 并行维护,提供非连接性的同步读取。 */
  private readonly infos = new Map<string, RemoteConnectionInfo>()
  private readonly states = new Map<string, ConnectionState>()
  private readonly stateMessages = new Map<string, string | undefined>()
  /** 活动端口转发(profileId:remotePort → 隧道)。预览与手动绑定共用。 */
  private readonly forwards = new Map<string, ForwardEntry>()

  constructor(
    private readonly context: SshContext,
    private readonly artifacts: RemoteArtifactSource,
    private readonly onStage?: (
      profileId: string,
      stage: ProvisionStage | 'connecting' | 'tunneling' | 'ready',
      message?: string
    ) => void,
    private readonly onStateChange?: (
      profileId: string,
      state: ConnectionState,
      message?: string
    ) => void,
    private readonly onForwardsChanged?: (profileId: string) => void
  ) {}

  /** 当前连接状态(不会触发连接)。未连接过的主机视为 disconnected。 */
  getState(profileId: string): ConnectionStateView {
    return {
      state: this.states.get(profileId) ?? 'disconnected',
      message: this.stateMessages.get(profileId)
    }
  }

  /** 已建立的连接信息(不会触发连接);未建立或已断开为 undefined。 */
  getInfo(profileId: string): RemoteConnectionInfo | undefined {
    return this.infos.get(profileId)
  }

  private setState(profileId: string, state: ConnectionState, message?: string): void {
    this.states.set(profileId, state)
    if (message === undefined) this.stateMessages.delete(profileId)
    else this.stateMessages.set(profileId, message)
    this.onStateChange?.(profileId, state, message)
  }

  /** 建立(或复用)到某主机的连接。同一 profileId 并发调用共享一次建立过程。 */
  ensure(profileId: string, endpoint: SshEndpoint): Promise<RemoteConnectionInfo> {
    const existing = this.connections.get(profileId)
    if (existing) {
      return this.reuseOrRebuild(profileId, endpoint, existing)
    }

    const task = this.connect(profileId, endpoint)
    this.connections.set(profileId, task)
    // 失败的连接不留缓存 —— 下次调用应当重试,而不是永久拿到同一个 rejected promise。
    task.catch((error) => {
      this.connections.delete(profileId)
      this.infos.delete(profileId)
      this.setState(profileId, 'error', errorMessage(error))
    })
    return task.then((connection) => connection.info)
  }

  /**
   * 复用缓存连接前做一次 liveness 检查(经隧道请求 /health)。
   * 远程 server 被杀但隧道进程还活着时,缓存会变成「假活」——这正是用户担心的
   * 「不知道后端还能不能连上」。探测失败就清缓存重建(server 随 provision 自动重启)。
   */
  private async reuseOrRebuild(
    profileId: string,
    endpoint: SshEndpoint,
    cached: Promise<ActiveConnection>
  ): Promise<RemoteConnectionInfo> {
    const connection = await cached
    if (await isConnectionAlive(connection)) return connection.info
    // 后端确实死了:拆掉旧连接并重建。
    this.connections.delete(profileId)
    this.infos.delete(profileId)
    connection.tunnel.close()
    this.setState(profileId, 'connecting')
    const rebuilt = await this.connect(profileId, endpoint)
    this.connections.set(profileId, Promise.resolve(rebuilt))
    return rebuilt.info
  }

  /** 断开本地隧道与端口转发(不动远程 server)。 */
  async release(profileId: string): Promise<void> {
    const task = this.connections.get(profileId)
    this.connections.delete(profileId)
    this.infos.delete(profileId)
    const connection = await task?.catch(() => undefined)
    connection?.tunnel.close()
    this.closeAllForwards(profileId)
    this.setState(profileId, 'disconnected')
  }

  /** 某主机的全部活动转发(不会触发连接)。 */
  listForwards(profileId: string): PortForwardWire[] {
    const result: PortForwardWire[] = []
    for (const [key, entry] of this.forwards) {
      if (!key.startsWith(`${profileId}:`)) continue
      result.push({
        hostProfileId: profileId,
        remotePort: Number(key.slice(profileId.length + 1)),
        localPort: entry.tunnel.localPort,
        origin: entry.origin
      })
    }
    return result.sort((left, right) => left.remotePort - right.remotePort)
  }

  /**
   * 建立(或复用)远端 localhost:<remotePort> 的本地转发,返回本地端口。
   * 同一 (profileId, remotePort) 复用已有隧道;新建/复用都不重复广播。
   */
  async openForward(
    profileId: string,
    endpoint: SshEndpoint,
    remotePort: number,
    origin: 'preview' | 'manual'
  ): Promise<number> {
    const key = `${profileId}:${remotePort}`
    const existing = this.forwards.get(key)
    if (existing) return existing.tunnel.localPort
    await ensureMaster(this.context, endpoint)
    const tunnel = await startTunnel(this.context, endpoint, remotePort)
    this.forwards.set(key, { tunnel, origin })
    this.onForwardsChanged?.(profileId)
    return tunnel.localPort
  }

  /** 关闭一条转发。不存在则忽略。 */
  closeForward(profileId: string, remotePort: number): void {
    const key = `${profileId}:${remotePort}`
    const entry = this.forwards.get(key)
    if (!entry) return
    this.forwards.delete(key)
    entry.tunnel.close()
    this.onForwardsChanged?.(profileId)
  }

  private closeAllForwards(profileId: string): void {
    let changed = false
    for (const [key, entry] of [...this.forwards]) {
      if (!key.startsWith(`${profileId}:`)) continue
      this.forwards.delete(key)
      entry.tunnel.close()
      changed = true
    }
    if (changed) this.onForwardsChanged?.(profileId)
  }

  /** 应用退出:收掉全部隧道与 SSH 控制连接。 */
  async closeAll(endpoints: ReadonlyMap<string, SshEndpoint>): Promise<void> {
    const tasks = [...this.connections.values()]
    this.connections.clear()
    this.infos.clear()
    for (const task of tasks) {
      const connection = await task.catch(() => undefined)
      connection?.tunnel.close()
    }
    for (const entry of [...this.forwards.values()]) entry.tunnel.close()
    this.forwards.clear()
    for (const endpoint of endpoints.values()) {
      await stopMaster(this.context, endpoint).catch(() => {})
    }
  }

  private async connect(profileId: string, endpoint: SshEndpoint): Promise<ActiveConnection> {
    this.setState(profileId, 'connecting')
    this.onStage?.(profileId, 'connecting')
    await ensureMaster(this.context, endpoint)

    const artifacts = this.artifacts
    const provisioned = await provision(this.context, endpoint, {
      artifacts: {
        version: artifacts.version,
        protocolVersion: artifacts.protocolVersion,
        artifacts: Object.fromEntries(
          Object.entries(artifacts.artifacts).map(([target, artifact]) => [
            target,
            { file: artifact.file, sha256: artifact.sha256 }
          ])
        )
      },
      localArtifactPath: (target) => {
        const artifact = artifacts.artifacts[target]
        if (!artifact) throw new Error(`本地没有 ${target} 平台的 server 产物,请先 pnpm package`)
        return artifact.localPath
      },
      onStage: (stage, message) => this.onStage?.(profileId, stage, message)
    })

    this.onStage?.(profileId, 'tunneling')
    const tunnel = await startTunnel(this.context, endpoint, provisioned.port)
    tunnel.onExit = () => {
      // 隧道意外断开:缓存的连接已不可用,下次 ensure 重建;状态同步为断开。
      this.connections.delete(profileId)
      this.infos.delete(profileId)
      this.setState(profileId, 'disconnected', '隧道连接已断开')
    }
    this.onStage?.(profileId, 'ready')

    const info: RemoteConnectionInfo = {
      hostId: provisioned.hostId,
      baseUrl: `http://127.0.0.1:${tunnel.localPort}`,
      ...(provisioned.token ? { token: provisioned.token } : {}),
      localPort: tunnel.localPort,
      remotePort: provisioned.port
    }
    this.infos.set(profileId, info)
    this.setState(profileId, 'connected')

    return { info, tunnel }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
