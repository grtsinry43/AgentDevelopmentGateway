import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  cloneSessionExecutionSettings,
  type ApprovalAction,
  type ExecutionConfigurationResult,
  type PermissionRule,
  type PermissionToolKind,
  type SessionExecutionSettings,
} from '@agent-gateway/core'
import type {
  HookCallback,
  HookPermissionDecision,
  PermissionMode,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'

export interface ClaudeExecutionResolution extends ExecutionConfigurationResult {
  permissionMode: PermissionMode
}

interface ToolRequest {
  toolName: string
  toolKind: PermissionToolKind
  resource?: { kind: 'path' | 'command' | 'url' | 'mcp'; value: string }
}

export function resolveClaudeExecution(
  settings: SessionExecutionSettings,
): ClaudeExecutionResolution {
  const effective = cloneSessionExecutionSettings(settings)
  const limitations = []
  let permissionMode: PermissionMode

  if (settings.workMode === 'plan') {
    permissionMode = 'plan'
    if (settings.approval.defaultAction === 'allow') {
      limitations.push({
        capability: 'approval.defaultAction',
        reason: 'Claude plan mode still routes write operations through approval',
      })
    }
  } else if (settings.approval.reviewer === 'provider') {
    permissionMode = 'auto'
  } else if (settings.approval.defaultAction === 'deny') {
    permissionMode = 'dontAsk'
  } else if (
    settings.approval.defaultAction === 'allow' &&
    settings.sandbox.filesystem === 'unrestricted' &&
    settings.sandbox.network === 'allow'
  ) {
    permissionMode = 'bypassPermissions'
  } else if (isAcceptEditsPolicy(settings)) {
    permissionMode = 'acceptEdits'
  } else {
    permissionMode = 'default'
  }

  if (settings.sandbox.filesystem !== 'unrestricted') {
    limitations.push({
      capability: 'sandbox.filesystem',
      reason: 'Claude Code enforces a permission boundary, not an operating-system sandbox',
    })
  }
  if (settings.sandbox.network !== 'allow') {
    limitations.push({
      capability: 'sandbox.network',
      reason: 'Network tools are gated, but shell commands are not network-isolated by the SDK',
    })
  }

  return { permissionMode, effective, limitations }
}

export function createClaudePreToolUseHook(
  currentSettings: () => SessionExecutionSettings,
  projectPath: string,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const decision = evaluateClaudeToolRequest(currentSettings(), input, projectPath)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: `Gateway execution policy resolved ${decision}`,
      },
    }
  }
}

export function evaluateClaudeToolRequest(
  settings: SessionExecutionSettings,
  input: PreToolUseHookInput,
  projectPath: string,
): HookPermissionDecision {
  const request = describeToolRequest(input.tool_name, input.tool_input)

  if (settings.workMode === 'plan' && (request.toolKind === 'write' || request.toolKind === 'execute')) {
    return 'ask'
  }
  if (settings.sandbox.filesystem === 'read-only' && request.toolKind === 'write') return 'deny'
  if (
    settings.sandbox.filesystem === 'workspace-write' &&
    request.toolKind === 'write' &&
    request.resource?.kind === 'path' &&
    !isWithinProject(request.resource.value, projectPath)
  ) {
    return 'deny'
  }
  if (settings.sandbox.network === 'deny' && request.toolKind === 'network') return 'deny'
  if (settings.sandbox.network === 'ask' && request.toolKind === 'network') return 'ask'

  let action: ApprovalAction = settings.approval.defaultAction
  for (const rule of settings.approval.rules) {
    if (matchesRule(rule, request)) action = rule.action
  }
  if (action === 'allow') return 'allow'
  if (action === 'deny') return 'deny'
  return settings.approval.reviewer === 'provider' ? 'defer' : 'ask'
}

function isAcceptEditsPolicy(settings: SessionExecutionSettings): boolean {
  return (
    settings.workMode === 'build' &&
    settings.approval.defaultAction === 'ask' &&
    settings.approval.reviewer === 'user' &&
    settings.approval.rules.length === 1 &&
    settings.approval.rules[0]?.action === 'allow' &&
    settings.approval.rules[0]?.toolKind === 'write' &&
    settings.approval.rules[0]?.tool === undefined &&
    settings.approval.rules[0]?.resource === undefined
  )
}

function describeToolRequest(toolName: string, input: unknown): ToolRequest {
  const record = isRecord(input) ? input : {}
  const normalized = toolName.toLowerCase()
  const resource = extractResource(normalized, record)
  let toolKind: PermissionToolKind = 'other'
  if (normalized === 'read') toolKind = 'read'
  else if (normalized === 'edit' || normalized === 'write' || normalized === 'notebookedit') {
    toolKind = 'write'
  } else if (normalized === 'bash') toolKind = 'execute'
  else if (normalized === 'glob' || normalized === 'grep') toolKind = 'search'
  else if (normalized === 'webfetch' || normalized === 'websearch') toolKind = 'network'
  else if (normalized === 'askuserquestion') toolKind = 'question'
  else if (normalized.startsWith('mcp__')) toolKind = 'mcp'
  return { toolName, toolKind, ...(resource ? { resource } : {}) }
}

function extractResource(
  toolName: string,
  input: Record<string, unknown>,
): ToolRequest['resource'] {
  const path = firstString(input, ['file_path', 'path', 'notebook_path'])
  if (path) return { kind: 'path', value: path }
  if (toolName === 'bash' && typeof input.command === 'string') {
    return { kind: 'command', value: input.command }
  }
  const url = firstString(input, ['url'])
  if (url) return { kind: 'url', value: url }
  if (toolName.startsWith('mcp__')) return { kind: 'mcp', value: toolName }
  return undefined
}

function matchesRule(rule: PermissionRule, request: ToolRequest): boolean {
  if (rule.toolKind && rule.toolKind !== request.toolKind) return false
  if (rule.tool && !wildcardMatch(rule.tool, request.toolName)) return false
  if (rule.resource) {
    if (!request.resource || rule.resource.kind !== request.resource.kind) return false
    if (!wildcardMatch(rule.resource.pattern, request.resource.value)) return false
  }
  return rule.toolKind !== undefined || rule.tool !== undefined || rule.resource !== undefined
}

function wildcardMatch(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${expression}$`, 'i').test(value)
}

function isWithinProject(path: string, projectPath: string): boolean {
  const root = resolve(projectPath)
  const candidate = resolve(root, path)
  const relation = relative(root, candidate)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key]
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
