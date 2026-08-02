/**
 * 系统 ssh 封装 —— 不 import electron,可脱离 GUI 做无头端到端验证。
 *
 * 为什么用系统 ssh 而不是 ssh2 库:用户的 ~/.ssh/config、ssh-agent、ProxyJump、
 * 硬件密钥全部自动生效,与 VS Code Remote 同一选择。连接复用靠 ControlMaster:
 * 首次 ensureMaster 完成认证后,后续 runRemote/upload/tunnel 全部走同一控制连接。
 *
 * 密码认证不依赖 sshpass:OpenSSH >= 8.4 支持 SSH_ASKPASS_REQUIRE=force,
 * 配合一个 0700 的 askpass 助手脚本即可非交互输入密码。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { connect as connectTcp, createServer } from 'node:net'
import { join } from 'node:path'

export interface SshEndpoint {
  username: string
  hostname: string
  port: number
  /** auth=key 的私钥路径。 */
  keyPath?: string
  /** auth=password 的明文密码;仅存在于内存,经 env 传给 askpass 助手。 */
  password?: string
}

export interface SshContext {
  /** ControlMaster socket 目录(unix socket 路径有长度上限,必须短,如 /tmp/agw-ssh-$UID)。 */
  socketDir: string
  /** askpass 助手脚本路径(0700,内容不含密码,密码经 env 传递)。 */
  askpassPath: string
}

export class SshError extends Error {
  constructor(
    readonly kind: 'auth' | 'unreachable' | 'host-key' | 'failed',
    message: string
  ) {
    super(message)
    this.name = 'SshError'
  }
}

export interface RemoteRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface TunnelHandle {
  localPort: number
  close(): void
  /** 隧道进程意外退出(resolve 退出码);调用方 close() 时不触发。 */
  onExit: (() => void) | undefined
}

function socketPath(context: SshContext, endpoint: SshEndpoint): string {
  const hash = createHash('sha256')
    .update(`${endpoint.username}@${endpoint.hostname}:${endpoint.port}`)
    .digest('hex')
    .slice(0, 12)
  return join(context.socketDir, `agw-${hash}`)
}

function destination(endpoint: SshEndpoint): string {
  return `${endpoint.username}@${endpoint.hostname}`
}

function baseArgs(context: SshContext, endpoint: SshEndpoint, tool: 'ssh' | 'scp' = 'ssh'): string[] {
  const args = [
    '-o',
    `ControlPath=${socketPath(context, endpoint)}`,
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=accept-new',
    // 端口 flag 两个工具不一样:ssh 是 -p,scp 是 -P(scp 的 -p 是保留时间戳)。
    tool === 'scp' ? '-P' : '-p',
    String(endpoint.port)
  ]
  if (endpoint.keyPath) {
    args.push('-i', endpoint.keyPath, '-o', 'IdentitiesOnly=yes')
  }
  if (!endpoint.password) {
    // 密钥认证下禁止交互:密码短语只能由 ssh-agent 提供,挂住比直接失败更难查。
    args.push('-o', 'BatchMode=yes')
  }
  return args
}

function sshEnvironment(endpoint: SshEndpoint): NodeJS.ProcessEnv {
  if (!endpoint.password) return process.env
  return {
    ...process.env,
    SSH_ASKPASS_REQUIRE: 'force',
    AGENT_GATEWAY_SSH_PASSWORD: endpoint.password
  }
}

/** 密码经环境变量交给 askpass 助手,不落盘、不进命令行(ps 可见)。 */
export function writeAskpassHelper(context: SshContext, askpassPath: string): void {
  writeFileSync(
    askpassPath,
    '#!/bin/sh\nprintf %s "$AGENT_GATEWAY_SSH_PASSWORD"\n',
    { mode: 0o700 }
  )
  chmodSync(askpassPath, 0o700)
}

function spawnCapture(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<RemoteRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
    // stdio 已声明为 pipe,流必然存在;类型收窄只做一次。
    const childStdout = child.stdout
    const childStderr = child.stderr
    if (!childStdout || !childStderr) {
      reject(new Error(`无法捕获 ${command} 的输出`))
      return
    }
    let stdout = ''
    let stderr = ''
    childStdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    childStderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input)
      child.stdin.end()
    }
  })
}

function classifySshFailure(result: RemoteRunResult): SshError {
  const text = `${result.stderr}\n${result.stdout}`
  if (/permission denied/i.test(text)) {
    return new SshError('auth', 'SSH 认证失败:请检查用户名、私钥或密码')
  }
  if (/host key verification failed/i.test(text)) {
    return new SshError('host-key', 'SSH 主机密钥校验失败:known_hosts 记录与主机不符')
  }
  if (/connection refused|timed out|no route to host|could not resolve hostname|name or service not known/i.test(text)) {
    return new SshError('unreachable', `SSH 无法连接主机:${firstLine(result.stderr)}`)
  }
  return new SshError('failed', `SSH 失败:${firstLine(result.stderr) || `exit ${result.code}`}`)
}

function firstLine(value: string): string {
  return value.trim().split('\n')[0] ?? ''
}

async function masterAlive(context: SshContext, endpoint: SshEndpoint): Promise<boolean> {
  const result = await spawnCapture('ssh', [
    '-O',
    'check',
    '-o',
    `ControlPath=${socketPath(context, endpoint)}`,
    destination(endpoint)
  ])
  return result.code === 0
}

/** 建立(或复用)到该主机的 ControlMaster 控制连接;认证只发生在这里。 */
export async function ensureMaster(context: SshContext, endpoint: SshEndpoint): Promise<void> {
  if (await masterAlive(context, endpoint)) return
  mkdirSync(context.socketDir, { recursive: true, mode: 0o700 })
  if (endpoint.password) writeAskpassHelper(context, context.askpassPath)

  const result = await spawnCapture(
    'ssh',
    [
      ...baseArgs(context, endpoint),
      '-M',
      '-N',
      '-f',
      '-o',
      'ControlMaster=yes',
      '-o',
      'ControlPersist=30m',
      destination(endpoint)
    ],
    { env: sshEnvironment(endpoint) }
  )
  if (result.code !== 0) throw classifySshFailure(result)
}

/** 在远端执行 POSIX sh 脚本(stdin 传入),收集 stdout/stderr 与退出码。 */
export function runRemote(
  context: SshContext,
  endpoint: SshEndpoint,
  script: string
): Promise<RemoteRunResult> {
  return spawnCapture(
    'ssh',
    [...baseArgs(context, endpoint), destination(endpoint), 'sh', '-s'],
    { env: sshEnvironment(endpoint), input: script }
  )
}

/** 上传文件到远端目录(走 ControlMaster 控制连接,不重新认证)。 */
export async function upload(
  context: SshContext,
  endpoint: SshEndpoint,
  localPath: string,
  remoteDirectory: string
): Promise<void> {
  const makeDirectory = await runRemote(context, endpoint, `mkdir -p '${remoteDirectory}'`)
  if (makeDirectory.code !== 0) {
    throw new SshError('failed', `远端创建目录失败:${firstLine(makeDirectory.stderr)}`)
  }
  const result = await spawnCapture('scp', [
    ...baseArgs(context, endpoint, 'scp'),
    localPath,
    `${destination(endpoint)}:${remoteDirectory}/`
  ])
  if (result.code !== 0) throw classifySshFailure(result)
}

async function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('无法分配本地端口'))))
    })
  })
}

async function waitForLocalPort(localPort: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 8_000
  for (;;) {
    if (child.exitCode !== null) throw new SshError('failed', 'SSH 隧道进程提前退出')
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connectTcp({ port: localPort, host: '127.0.0.1' })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (connected) return
    if (Date.now() > deadline) throw new SshError('failed', '等待 SSH 隧道就绪超时')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * 建立本地端口转发:127.0.0.1:localPort → 远端 127.0.0.1:remotePort。
 * 远端 server 只监听 loopback,这是唯一入口。
 */
export async function startTunnel(
  context: SshContext,
  endpoint: SshEndpoint,
  remotePort: number
): Promise<TunnelHandle> {
  const localPort = await allocateLocalPort()
  const child = spawn('ssh', [
    ...baseArgs(context, endpoint),
    '-N',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    destination(endpoint)
  ])
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

  const handle: TunnelHandle = {
    localPort,
    onExit: undefined,
    close(): void {
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
    }
  }
  child.on('exit', () => handle.onExit?.())
  try {
    await waitForLocalPort(localPort, child)
  } catch (error) {
    handle.close()
    if (error instanceof SshError && stderr) throw new SshError(error.kind, firstLine(stderr))
    throw error
  }
  return handle
}

/** 断开控制连接(应用退出或删除主机时调用)。 */
export async function stopMaster(context: SshContext, endpoint: SshEndpoint): Promise<void> {
  await spawnCapture('ssh', [
    '-O',
    'exit',
    '-o',
    `ControlPath=${socketPath(context, endpoint)}`,
    destination(endpoint)
  ])
}

/** 快捷连通性探测:短超时跑 `true`,不建立控制连接。用于 Launcher 主机在线检测。 */
export async function probeReachable(context: SshContext, endpoint: SshEndpoint): Promise<boolean> {
  const args = baseArgs(context, endpoint).map((arg) =>
    arg === 'ConnectTimeout=10' ? 'ConnectTimeout=3' : arg
  )
  const result = await spawnCapture('ssh', [...args, destination(endpoint), 'true'])
  return result.code === 0
}

function runtimeJsonScript(body: string): string {
  return [
    'ROOT="$HOME/.agent-development-gateway/server"',
    'f="$ROOT/runtime.json"',
    '[ -f "$f" ] || { echo NO_RUNTIME; exit 0; }',
    'PID=$(grep -o \'"pid":[0-9]*\' "$f" | head -1 | cut -d: -f2)',
    body,
    'echo UNKNOWN'
  ].join('\n')
}

/** Gateway Server 守护进程是否在运行(runtime.json 里的 pid 存活)。 */
export async function isServerRunning(
  context: SshContext,
  endpoint: SshEndpoint
): Promise<boolean> {
  const result = await runRemote(
    context,
    endpoint,
    runtimeJsonScript(
      '[ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && { echo RUNNING; exit 0; } || true'
    )
  )
  return /RUNNING/.test(result.stdout)
}

/** 优雅停止远程 Gateway Server(SIGTERM,server 自己清理 runtime.json)。 */
export async function stopServer(
  context: SshContext,
  endpoint: SshEndpoint
): Promise<void> {
  await runRemote(
    context,
    endpoint,
    runtimeJsonScript('[ -n "$PID" ] && kill -TERM "$PID" 2>/dev/null || true')
  )
}

/** 读取远端已安装的 server 版本(versions 下最新一份 install.json)。 */
export async function readInstalledServerVersion(
  context: SshContext,
  endpoint: SshEndpoint
): Promise<{ version: string; protocolVersion: number } | undefined> {
  const script = [
    'ROOT="$HOME/.agent-development-gateway/server"',
    'f=$(ls -1 "$ROOT/versions/"*/install.json 2>/dev/null | sort | tail -1)',
    '[ -n "$f" ] || { echo NONE; exit 0; }',
    'V=$(sed -n \'s/.*"version": *"\\([^"]*\\)".*/\\1/p\' "$f" | head -1)',
    'P=$(sed -n \'s/.*"protocolVersion": *\\([0-9]*\\).*/\\1/p\' "$f" | head -1)',
    '[ -n "$V" ] || { echo NONE; exit 0; }',
    'echo "$V $P"'
  ].join('\n')
  const result = await runRemote(context, endpoint, script)
  const match = result.stdout.trim().match(/^(\S+) (\d+)$/)
  const version = match?.[1]
  if (!match || version === undefined) return undefined
  return { version, protocolVersion: Number(match[2]) }
}

/** 清空远端安装目录(重装用),保留 runtime.json 与 server.log 便于诊断。 */
export async function clearServerInstall(
  context: SshContext,
  endpoint: SshEndpoint
): Promise<void> {
  await runRemote(
    context,
    endpoint,
    'rm -rf "$HOME/.agent-development-gateway/server/versions" "$HOME/.agent-development-gateway/server/downloads"'
  )
}

export interface LogStreamHandle {
  close(): void
}

/**
 * 串流远程 server.log(`tail -F` 跟随轮转)。行按完整行回调;远端退出时 close 返回。
 * 依赖已有 ControlMaster(不重复认证)。
 */
export function startRemoteLogStream(
  context: SshContext,
  endpoint: SshEndpoint,
  logPath: string,
  onLine: (line: string) => void
): LogStreamHandle {
  const child = spawn('ssh', [
    ...baseArgs(context, endpoint),
    destination(endpoint),
    'tail',
    '-n',
    '300',
    '-F',
    logPath
  ])
  child.stdout.setEncoding('utf8')
  let buffer = ''
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) onLine(line)
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', () => {
    // 远端没有日志文件时会报错;走 exit 统一处理。
  })
  child.on('error', () => {
    /* exit 兜底 */
  })
  return {
    close(): void {
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
    }
  }
}
