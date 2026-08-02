/**
 * 本地 Gateway Server 生命周期管理。
 *
 * Electron 承载后端的实践:
 *  - **子进程**而非同进程:崩溃隔离、不阻塞主进程事件循环、server 的 exit 不会带走 UI;
 *  - **PORT=0 + stdout 哨兵**:避免固定端口冲突,启动后从哨兵拿真实端口;
 *  - **ELECTRON_RUN_AS_NODE + process.execPath**:复用应用自带运行时,不依赖系统 node;
 *  - **幂等 ensure**:先探活「已有实例」(比如 dev 时手动起的 server),活着就复用,
 *    不重复拉起;否则才 spawn;
 *  - **数据目录归应用**:userData/server,应用退出才停(关窗口不停,与远程一致)。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, openSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { listeningSchema } from '../remote/provision.js'
import { GatewayServerClient, LOCAL_SERVER_URL } from '../server/client.js'

/** 与远程/手动 dev server 同一数据目录约定,身份(hosId)完全兼容。 */
const DEFAULT_DATA_DIR = join(homedir(), '.agent-development-gateway', 'server')

export interface LocalServerInfo {
  baseUrl: string
  hostId: string
  version: string
  protocolVersion: number
  dataDirectory: string
}

/** dev:electron-vite 以 cwd=apps/desktop 启动,server 产物在 ../server/dist。 */
const DEV_SERVER_ENTRY = resolve(app.getAppPath(), '../server/dist/index.js')

const SPAWN_TIMEOUT_MS = 20_000

export class LocalServerManager {
  private server: ChildProcess | undefined
  private info: LocalServerInfo | undefined
  private starting: Promise<LocalServerInfo> | undefined

  /** 确保本地 server 可用(复用运行中实例或拉起新的)。 */
  ensure(): Promise<LocalServerInfo> {
    if (this.starting) return this.starting
    const task = this.resolve().finally(() => {
      this.starting = undefined
    })
    this.starting = task
    return task
  }

  /** 应用退出时优雅停止我们拉起的 server(不碰外部已存在的实例)。 */
  async stop(): Promise<void> {
    const child = this.server
    this.server = undefined
    this.info = undefined
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
    }
  }

  private async resolve(): Promise<LocalServerInfo> {
    if (this.info && (await this.alive(this.info.baseUrl))) return this.info
    const existing = await this.discoverExisting()
    if (existing) {
      this.info = existing
      return existing
    }
    const spawned = await this.spawn()
    this.info = spawned
    return spawned
  }

  private async alive(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1_500)
      })
      return response.ok
    } catch {
      return false
    }
  }

  /** 复用已在本机运行的外部实例(如 dev 时手动起的 server)。 */
  private async discoverExisting(): Promise<LocalServerInfo | undefined> {
    const client = new GatewayServerClient(LOCAL_SERVER_URL)
    try {
      const serverInfo = await client.serverInfo()
      return {
        baseUrl: LOCAL_SERVER_URL,
        hostId: serverInfo.hostId,
        version: serverInfo.version,
        protocolVersion: serverInfo.protocolVersion,
        dataDirectory: process.env.AGENT_GATEWAY_DATA_DIR ?? DEFAULT_DATA_DIR
      }
    } catch {
      return undefined
    }
  }

  /** 从仓库产物拉起本地 server,解析 stdout 哨兵拿到端口。 */
  private async spawn(): Promise<LocalServerInfo> {
    const entry = DEV_SERVER_ENTRY
    if (!existsSync(entry)) {
      throw new Error(`找不到本地 server 产物: ${entry}\n请先运行 pnpm build`)
    }

    const dataDirectory = process.env.AGENT_GATEWAY_DATA_DIR ?? DEFAULT_DATA_DIR
    mkdirSync(dataDirectory, { recursive: true })
    const logFile = join(dataDirectory, 'server.log')
    // openSync 返回的是 fd(数字),不是流;用 createWriteStream 包一层再 pipe。
    const logStream = createWriteStream('', { fd: openSync(logFile, 'a') })
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: '0',
        AGENT_GATEWAY_AUTH: 'none'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached:false —— 让应用退出时能收到子进程终止(配合 SIGTERM 优雅关停)
    })
    this.server = child

    const tee = (stream: Readable | null, target: NodeJS.WritableStream): void => {
      stream?.pipe(target)
    }
    tee(child.stdout, logStream)
    tee(child.stderr, logStream)

    child.on('exit', () => {
      if (this.server === child) {
        this.server = undefined
        this.info = undefined
      }
    })

    try {
      const sentinel = await waitForSentinel(child.stdout, child.pid ?? -1, SPAWN_TIMEOUT_MS)
      return {
        baseUrl: `http://127.0.0.1:${sentinel.port}`,
        hostId: sentinel.hostId,
        version: sentinel.version,
        protocolVersion: sentinel.protocolVersion,
        dataDirectory
      }
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
  }
}

/** 从子进程 stdout 解析 AGENT_GATEWAY_LISTENING 哨兵(与远端 bootstrap 同一契约)。 */
function waitForSentinel(
  stream: Readable,
  pid: number,
  timeoutMs: number
): Promise<ReturnType<typeof listeningSchema.parse>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error(`本地 server 启动超时(${timeoutMs / 1000}s),请查看 server.log`))
    }, timeoutMs)
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      const marker = 'AGENT_GATEWAY_LISTENING '
      const index = buffer.indexOf(marker)
      if (index < 0) return
      const line = buffer.slice(index).split('\n')[0] ?? ''
      const parsed = listeningSchema.safeParse(JSON.parse(line.slice(marker.length)))
      if (parsed.success && parsed.data.pid === pid) {
        clearTimeout(timer)
        resolve(parsed.data)
      }
    })
    stream.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export const localServerManager = new LocalServerManager()
