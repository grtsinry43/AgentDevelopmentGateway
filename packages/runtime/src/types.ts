import type {
  AdapterId,
  AgentSession,
  InteractionRequest,
  InputQueueEntry,
  ModelCatalog,
  ModelSelection,
  ProviderRuntimeConfig,
  RuntimeAdapterDescriptor,
  RuntimeConnection,
  RuntimeError,
  RuntimeHostContext,
  SlashCommand,
  RuntimeInstallation,
  RuntimeEvent,
  SessionId,
  SessionExecutionSettings,
  TaskState,
  SubagentRun,
} from '@agent-gateway/core'
import type { RuntimeInputAdmission } from './runtime-projection.js'

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
  providerConfig?: ProviderRuntimeConfig
  model?: ModelSelection
  execution?: SessionExecutionSettings
}

export interface ListRuntimeModelsInput {
  host: RuntimeHostContext
  projectPath: string
  adapterId: AdapterId
  installationPath?: string
  providerConfig?: ProviderRuntimeConfig
}

/** 拉取 slash 命令/技能目录的运行时入参(与模型目录同构)。 */
export interface ListRuntimeCommandsInput {
  host: RuntimeHostContext
  projectPath: string
  adapterId: AdapterId
  installationPath?: string
  providerConfig?: ProviderRuntimeConfig
}

export type RuntimeModelCatalog = ModelCatalog
export type RuntimeSlashCommands = SlashCommand[]

export interface RuntimeSessionSnapshot {
  session: AgentSession
  connection: RuntimeConnection
  capabilities: RuntimeConnection['capabilities']
  pendingInteractions: InteractionRequest[]
  taskState: TaskState
  subagentRuns: SubagentRun[]
  inputQueue: InputQueueEntry[]
}

export interface RuntimeControlOptions {
  expectedRevision?: number
}

export interface RuntimeControlReceipt {
  controlRevision: number
}

export interface ResumeRuntimeSessionInput extends CreateRuntimeSessionInput {
  sessionId: SessionId
  runtimeSessionId: string
  previousSession: AgentSession
  cursor?: import('@agent-gateway/core').ResumeCursor
  providerStateSnapshot?: string
  taskState: TaskState
  subagentRuns: SubagentRun[]
  inputQueue: InputQueueEntry[]
  inputAdmissions: RuntimeInputAdmission[]
}

export interface ForkRuntimeSessionInput {
  sourceSessionId: SessionId
  forkPoint?: import('@agent-gateway/core').ResumeCursor
  execution?: SessionExecutionSettings
}

/** Synchronous durability boundary. append must finish before an event becomes observable. */
export interface RuntimeEventSink {
  append(event: RuntimeEvent): void
  discardSession(sessionId: SessionId): void
}
