import type { RuntimeAdapterDescriptor, RuntimeCapabilities } from '../domain/descriptor.js'
import type {
  ExecutionConfigurationResult,
  SessionExecutionSettings,
} from '../domain/execution.js'
import type { SessionId } from '../ids.js'
import type { AdapterEvent } from '../events/event-map.js'
import type {
  CreateSessionInput,
  ForkSessionInput,
  InteractionResolution,
  InterruptOptions,
  ListModelsInput,
  ModelCatalog,
  ModelSelection,
  ResumeSessionInput,
  AdapterSendResult,
  SendOptions,
  UserInput,
} from './io.js'
import type {
  RuntimeConnectOptions,
  RuntimeConnection,
  RuntimeHostContext,
  RuntimeInstallation,
  RuntimeSessionHandle,
} from './connection.js'

/**
 * A request the RUNTIME makes of the client, which the client must answer (Codex is
 * bidirectional: approvals aside, it asks the client to execute dynamic tools, run MCP
 * elicitation, read the current time, produce an attestation — docs/05 §7.1). This is
 * distinct from an InteractionRequest: those are answered via `resolveInteraction`; these
 * need a typed response the runtime consumes to continue the turn.
 */
export interface ServerRequest {
  id: string
  sessionId: SessionId
  /** Namespaced request kind, e.g. `codex.dynamicTool.call`, `codex.attestation`. */
  method: string
  params: unknown
}
export interface ServerResponse {
  id: string
  result: unknown
}
export type ServerRequestHandler = (req: ServerRequest) => Promise<ServerResponse>

/** A resource the caller can release (host un-registering a server-request handler). */
export interface Disposable {
  dispose(): void
}

/**
 * RuntimeAdapter — the anti-corruption boundary (requirements §4.7, §9.3). Every
 * client / event store / memory layer depends only on this, never on an upstream
 * runtime's raw protocol.
 *
 * Optional methods pair with capabilities (registry parity check):
 *   - `forkSession?`     ↔ features['session.fork']
 *   - `setModel?`        ↔ RuntimeCapabilities.modelSwitch !== 'unsupported'
 *   - `listModels?`      ↔ features['model.catalog']
 *   - `getCapabilities?` ↔ capabilities can change mid-session
 *   - `onServerRequest?` ↔ the runtime is bidirectional (Codex)
 *
 * Lifecycle (§9.2, docs/05 §13): detect → connect → create/resume → send → events() →
 * resolveInteraction / onServerRequest → interrupt → disposeSession.
 */
export interface RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor

  detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]>
  connect(options: RuntimeConnectOptions): Promise<RuntimeConnection>

  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle>
  resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle>
  forkSession?(input: ForkSessionInput): Promise<RuntimeSessionHandle>

  /** Deliver input already admitted by Gateway; any returned sequence remains provider-scoped. */
  send(
    sessionId: SessionId,
    input: UserInput,
    options: SendOptions,
  ): Promise<void | AdapterSendResult>
  interrupt(sessionId: SessionId, options?: InterruptOptions): Promise<void>
  resolveInteraction(sessionId: SessionId, resolution: InteractionResolution): Promise<void>
  listModels?(input: ListModelsInput): Promise<ModelCatalog>
  setModel?(sessionId: SessionId, model: ModelSelection): Promise<void>
  /** Atomically apply work mode, approval policy, and sandbox intent. */
  configureExecution?(
    sessionId: SessionId,
    settings: SessionExecutionSettings,
  ): Promise<ExecutionConfigurationResult>
  disposeSession(sessionId: SessionId): Promise<void>
  /** Release adapter-owned transports/processes during host shutdown. */
  dispose?(): Promise<void>

  /** Pre-envelope events for a session; the runtime layer seals them into the store (§8.3). */
  events(sessionId: SessionId): AsyncIterable<AdapterEvent>

  /** Current capabilities, when they can drift from the connect-time snapshot. */
  getCapabilities?(sessionId: SessionId): Promise<RuntimeCapabilities>

  /**
   * Register a handler for runtime-initiated requests (bidirectional runtimes). Returns
   * a Disposable to unregister. Absent on runtimes the client only drives one-way.
   */
  onServerRequest?(handler: ServerRequestHandler): Disposable
}
