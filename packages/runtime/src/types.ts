import type {
  AdapterId,
  AgentSession,
  ModelSelection,
  RuntimeAdapterDescriptor,
  RuntimeConnection,
  RuntimeError,
  RuntimeHostContext,
  RuntimeInstallation,
  RuntimeEvent,
  SessionId,
} from '@agent-gateway/core'

export interface RuntimeAdapterAvailability {
  adapterId: AdapterId
  descriptor: RuntimeAdapterDescriptor
  status: 'available' | 'unavailable'
  installations: RuntimeInstallation[]
  error?: RuntimeError
}

/** Server-resolved input. The client never supplies an unchecked project path. */
export interface CreateRuntimeSessionInput {
  projectId: string
  host: RuntimeHostContext
  projectPath: string
  adapterId: AdapterId
  installationPath?: string
  providerProfileId?: string
  model?: ModelSelection
  mode?: 'default' | 'plan'
}

export interface RuntimeSessionSnapshot {
  session: AgentSession
  connection: RuntimeConnection
}

/** Synchronous durability boundary. append must finish before an event becomes observable. */
export interface RuntimeEventSink {
  append(event: RuntimeEvent): void
  discardSession(sessionId: SessionId): void
}
