import WebSocket, { type RawData } from 'ws'
import {
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  type TerminalClientMessage
} from '@agent-gateway/shared'
import { PUSH_CHANNEL, type PushEvent } from '../../contract/bridge.js'

const FAST_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const
const SLOW_RETRY_DELAY_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 20_000
const TERMINAL_TAKEN_OVER_CLOSE_CODE = 4001

export interface TerminalConnectionClient {
  terminalWebSocketUrl(terminalId: string): string
  /** 远程 server 启用 token 认证时,WS upgrade 也要带 Authorization。 */
  webSocketHeaders(): Record<string, string>
}

export interface TerminalConnectionContents {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  send(channel: string, event: PushEvent): void
}

interface ActiveTerminalConnection {
  client: TerminalConnectionClient
  contents: TerminalConnectionContents
  terminalId: string
  stopped: boolean
  attempt: number
  cols: number
  rows: number
  lastAcknowledgedSequence?: number
  socket?: WebSocket
  retryTimer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
  receivedPong: boolean
}

export class TerminalConnectionRegistry {
  private readonly active = new Map<string, ActiveTerminalConnection>()
  private readonly observedWebContents = new Set<number>()

  attach(
    contents: TerminalConnectionContents,
    client: TerminalConnectionClient,
    terminalId: string,
    afterSequence: number | undefined,
    cols: number,
    rows: number
  ): void {
    const key = connectionKey(contents.id, terminalId)
    this.stop(this.active.get(key))
    const entry: ActiveTerminalConnection = {
      client,
      contents,
      terminalId,
      stopped: false,
      attempt: 0,
      cols,
      rows,
      lastAcknowledgedSequence: afterSequence,
      receivedPong: true
    }
    this.active.set(key, entry)
    this.observeDestruction(contents)
    this.send(contents, { kind: 'terminal.stream', terminalId, state: 'connecting' })
    this.connect(entry)
  }

  detach(contents: TerminalConnectionContents, terminalId: string): void {
    const key = connectionKey(contents.id, terminalId)
    const entry = this.active.get(key)
    if (!entry) return
    this.active.delete(key)
    this.stop(entry)
  }

  input(contents: TerminalConnectionContents, terminalId: string, data: string): void {
    this.sendMessage(
      this.require(contents, terminalId),
      terminalClientMessageSchema.parse({ type: 'terminal.input', data })
    )
  }

  resize(
    contents: TerminalConnectionContents,
    terminalId: string,
    cols: number,
    rows: number
  ): void {
    const entry = this.require(contents, terminalId)
    entry.cols = cols
    entry.rows = rows
    if (entry.socket?.readyState === WebSocket.OPEN) {
      this.sendMessage(
        entry,
        terminalClientMessageSchema.parse({ type: 'terminal.resize', cols, rows })
      )
    }
  }

  acknowledge(
    contents: TerminalConnectionContents,
    terminalId: string,
    sequence: number
  ): void {
    const entry = this.require(contents, terminalId)
    if (
      entry.lastAcknowledgedSequence === undefined ||
      sequence > entry.lastAcknowledgedSequence
    ) {
      entry.lastAcknowledgedSequence = sequence
    }
    if (entry.socket?.readyState === WebSocket.OPEN) {
      this.sendMessage(
        entry,
        terminalClientMessageSchema.parse({ type: 'terminal.ack', sequence })
      )
    }
  }

  retry(contents: TerminalConnectionContents, terminalId: string): void {
    const entry = this.require(contents, terminalId)
    this.clearTimers(entry)
    const previous = entry.socket
    entry.socket = undefined
    previous?.close(1000, 'terminal_retry')
    entry.stopped = false
    entry.attempt = 0
    this.send(contents, { kind: 'terminal.stream', terminalId, state: 'connecting' })
    this.connect(entry)
  }

  private connect(entry: ActiveTerminalConnection): void {
    if (entry.stopped || entry.contents.isDestroyed()) return
    const socket = new WebSocket(entry.client.terminalWebSocketUrl(entry.terminalId), {
      perMessageDeflate: false,
      headers: entry.client.webSocketHeaders()
    })
    entry.socket = socket
    socket.on('open', () => {
      if (entry.socket !== socket || entry.stopped) return
      entry.receivedPong = true
      this.startHeartbeat(entry, socket)
      this.sendMessage(
        entry,
        terminalClientMessageSchema.parse({
          type: 'terminal.attach',
          afterSequence: entry.lastAcknowledgedSequence,
          cols: entry.cols,
          rows: entry.rows
        })
      )
    })
    socket.on('pong', () => {
      if (entry.socket === socket) entry.receivedPong = true
    })
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (entry.socket !== socket || entry.stopped) return
      if (isBinary) {
        this.reportProtocolError(entry, 'Gateway Server returned binary terminal data')
        return
      }
      const parsed = terminalServerMessageSchema.safeParse(parseJson(raw.toString()))
      if (!parsed.success) {
        this.reportProtocolError(entry, 'Gateway Server returned an invalid terminal message')
        return
      }
      if (parsed.data.type === 'terminal.ready' || parsed.data.type === 'terminal.snapshot') {
        entry.attempt = 0
        this.send(entry.contents, {
          kind: 'terminal.stream',
          terminalId: entry.terminalId,
          state: 'connected'
        })
      }
      this.send(entry.contents, {
        kind: 'terminal.message',
        terminalId: entry.terminalId,
        message: parsed.data
      })
    })
    socket.on('error', () => {
      // The close event owns retry classification and user-visible state.
    })
    socket.on('close', (code, reason) => {
      if (entry.socket !== socket) return
      entry.socket = undefined
      this.clearHeartbeat(entry)
      if (entry.stopped) return
      const closeReason = reason.toString()
      if (isTerminalClose(code, closeReason)) {
        this.send(entry.contents, {
          kind: 'terminal.stream',
          terminalId: entry.terminalId,
          state: 'closed',
          ...(code === TERMINAL_TAKEN_OVER_CLOSE_CODE
            ? { message: '终端已被其他客户端接管' }
            : {})
        })
        return
      }
      this.scheduleRetry(entry, closeReason || `WebSocket closed with code ${code}`)
    })
  }

  private reportProtocolError(entry: ActiveTerminalConnection, message: string): void {
    this.send(entry.contents, {
      kind: 'terminal.stream',
      terminalId: entry.terminalId,
      state: 'error',
      message
    })
  }

  private scheduleRetry(entry: ActiveTerminalConnection, message: string): void {
    entry.attempt += 1
    const delay = FAST_RETRY_DELAYS_MS[entry.attempt - 1] ?? SLOW_RETRY_DELAY_MS
    this.send(entry.contents, {
      kind: 'terminal.stream',
      terminalId: entry.terminalId,
      state: 'retrying',
      message,
      attempt: entry.attempt,
      retryAt: Date.now() + delay
    })
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined
      this.connect(entry)
    }, delay)
  }

  private sendMessage(entry: ActiveTerminalConnection, message: TerminalClientMessage): void {
    if (entry.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('终端连接尚未就绪')
    }
    entry.socket.send(JSON.stringify(message))
  }

  private require(
    contents: TerminalConnectionContents,
    terminalId: string
  ): ActiveTerminalConnection {
    const entry = this.active.get(connectionKey(contents.id, terminalId))
    if (!entry) throw new Error('终端连接尚未启动')
    return entry
  }

  private startHeartbeat(entry: ActiveTerminalConnection, socket: WebSocket): void {
    this.clearHeartbeat(entry)
    entry.heartbeatTimer = setInterval(() => {
      if (entry.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      if (!entry.receivedPong) {
        socket.terminate()
        return
      }
      entry.receivedPong = false
      socket.ping()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stop(entry: ActiveTerminalConnection | undefined): void {
    if (!entry) return
    entry.stopped = true
    this.clearTimers(entry)
    const socket = entry.socket
    entry.socket = undefined
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'desktop_detached')
    else if (socket) socket.terminate()
  }

  private clearTimers(entry: ActiveTerminalConnection): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
    this.clearHeartbeat(entry)
  }

  private clearHeartbeat(entry: ActiveTerminalConnection): void {
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer)
    entry.heartbeatTimer = undefined
  }

  private observeDestruction(contents: TerminalConnectionContents): void {
    if (this.observedWebContents.has(contents.id)) return
    this.observedWebContents.add(contents.id)
    contents.once('destroyed', () => {
      this.observedWebContents.delete(contents.id)
      const prefix = `${contents.id}:`
      for (const [key, entry] of this.active) {
        if (!key.startsWith(prefix)) continue
        this.active.delete(key)
        this.stop(entry)
      }
    })
  }

  private send(contents: TerminalConnectionContents, event: PushEvent): void {
    if (!contents.isDestroyed()) contents.send(PUSH_CHANNEL, event)
  }
}

function connectionKey(webContentsId: number, terminalId: string): string {
  return `${webContentsId}:${terminalId}`
}

function isTerminalClose(code: number, reason: string): boolean {
  return (
    code === TERMINAL_TAKEN_OVER_CLOSE_CODE ||
    (code === 1000 &&
      ['terminal_exited', 'terminal_closed', 'terminal_expired', 'server_shutdown'].includes(reason))
  )
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
