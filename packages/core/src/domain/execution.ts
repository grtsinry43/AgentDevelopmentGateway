/** What the agent is expected to do, independent of approval and sandbox policy. */
export type WorkMode = 'build' | 'plan'

/** The default or rule-specific decision for a tool request. */
export type ApprovalAction = 'allow' | 'ask' | 'deny'

/** Who resolves requests that remain interactive after policy evaluation. */
export type ApprovalReviewer = 'user' | 'provider'

export type PermissionResourceKind = 'path' | 'command' | 'url' | 'mcp'
export type PermissionToolKind =
  | 'read'
  | 'write'
  | 'execute'
  | 'search'
  | 'network'
  | 'mcp'
  | 'question'
  | 'other'

/**
 * Ordered portable permission rule. Adapters translate the subset they support and the
 * Gateway enforces the remainder before provider tool execution. Last matching rule wins.
 */
export interface PermissionRule {
  id: string
  action: ApprovalAction
  toolKind?: PermissionToolKind
  /** Provider-neutral tool name or glob, for example `Bash`, `edit`, or `mcp__github__*`. */
  tool?: string
  resource?: {
    kind: PermissionResourceKind
    pattern: string
  }
}

export interface ApprovalPolicy {
  defaultAction: ApprovalAction
  reviewer: ApprovalReviewer
  rules: PermissionRule[]
}

export interface SandboxPolicy {
  filesystem: 'read-only' | 'workspace-write' | 'unrestricted'
  network: 'deny' | 'ask' | 'allow'
}

export interface SessionExecutionSettings {
  workMode: WorkMode
  approval: ApprovalPolicy
  sandbox: SandboxPolicy
}

export interface ExecutionLimitation {
  capability: string
  reason: string
}

/** Configured intent plus the adapter-confirmed policy that is actually in force. */
export interface SessionExecutionState {
  configured: SessionExecutionSettings
  effective: SessionExecutionSettings
  limitations: ExecutionLimitation[]
}

/** Adapter result for an atomic execution-policy update. */
export interface ExecutionConfigurationResult {
  effective: SessionExecutionSettings
  limitations: ExecutionLimitation[]
}

export type ExecutionUpdateSupport = 'in-session' | 'create-only' | 'unsupported'

export interface ExecutionCapabilities {
  workModes: WorkMode[]
  approvalActions: ApprovalAction[]
  approvalReviewers: ApprovalReviewer[]
  filesystemSandbox: SandboxPolicy['filesystem'][]
  networkAccess: SandboxPolicy['network'][]
  update: ExecutionUpdateSupport
  granularRules: boolean
}

export function createDefaultSessionExecutionSettings(): SessionExecutionSettings {
  return {
    workMode: 'build',
    approval: {
      defaultAction: 'ask',
      reviewer: 'user',
      rules: [],
    },
    sandbox: {
      filesystem: 'workspace-write',
      network: 'ask',
    },
  }
}

export function cloneSessionExecutionSettings(
  settings: SessionExecutionSettings,
): SessionExecutionSettings {
  return {
    workMode: settings.workMode,
    approval: {
      defaultAction: settings.approval.defaultAction,
      reviewer: settings.approval.reviewer,
      rules: settings.approval.rules.map((rule) => ({
        ...rule,
        ...(rule.resource ? { resource: { ...rule.resource } } : {}),
      })),
    },
    sandbox: { ...settings.sandbox },
  }
}

export function cloneSessionExecutionState(state: SessionExecutionState): SessionExecutionState {
  return {
    configured: cloneSessionExecutionSettings(state.configured),
    effective: cloneSessionExecutionSettings(state.effective),
    limitations: state.limitations.map((limitation) => ({ ...limitation })),
  }
}
