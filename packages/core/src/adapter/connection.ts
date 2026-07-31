import type { RuntimeCapabilities } from '../domain/descriptor.js'
import type { SessionId } from '../ids.js'

/** Context passed to `detect()` — describes the host to probe (§9.3). */
export interface RuntimeHostContext {
  hostId: string
  platform?: string
  env?: Record<string, string>
}

/** A discovered runtime installation on a host (§9.3 `detect`). */
export interface RuntimeInstallation {
  path: string
  version?: string
  source: 'path' | 'npm' | 'managed' | 'custom'
}

export interface RuntimeConnectOptions {
  context: RuntimeHostContext
  installation?: RuntimeInstallation
}

/**
 * How the adapter physically talks to its runtime. Enumerates the real topologies
 * from the protocol analysis — the contract (`events()`) is identical across them:
 * - `sdk`             Claude Agent SDK (in-process async-iterable Query)
 * - `subprocess-jsonl`Codex Surface A (`codex exec --experimental-json`)
 * - `jsonrpc-stdio`   Codex Surface B (`codex app-server`, NDJSON over stdio)
 * - `jsonrpc-ws`      Codex app-server over websocket
 * - `http-sse`        OpenCode (`opencode serve` HTTP + SSE)
 */
export type ConnectionTransport =
  | 'sdk'
  | 'subprocess-jsonl'
  | 'jsonrpc-stdio'
  | 'jsonrpc-ws'
  | 'http-sse'

/**
 * A live connection to a runtime, with its negotiated capabilities (§9.2 Inspect
 * Capabilities). `capabilities` here is the INITIAL snapshot — capabilities can change
 * mid-session (Claude reloadSkills / MCP / commands), re-broadcast via
 * `session.capabilities_changed` (docs/05 §8).
 */
export interface RuntimeConnection {
  id: string
  transport: ConnectionTransport
  runtimeVersion?: string
  capabilities: RuntimeCapabilities
}

/** Handle to a created/resumed session (§9.3). */
export interface RuntimeSessionHandle {
  sessionId: SessionId
  /** The runtime's own session id (Claude UUID / Codex thread_id / OpenCode ses_*). */
  runtimeSessionId?: string
  /** Id of the turn started on create/resume, if any (Codex returns a turn). */
  activeTurnId?: string
}
