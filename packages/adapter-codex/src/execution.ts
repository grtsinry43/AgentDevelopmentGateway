import {
  cloneSessionExecutionSettings,
  type ExecutionConfigurationResult,
  type ModelSelection,
  type SessionExecutionSettings,
} from '@agent-gateway/core'
import type { JsonObject } from './protocol.js'

export function mapThreadCreationExecution(
  settings: SessionExecutionSettings,
): JsonObject {
  return {
    approvalPolicy: mapApprovalPolicy(settings),
    approvalsReviewer: mapApprovalReviewer(settings),
    sandbox: mapSandboxMode(settings),
  }
}

export function mapThreadSettings(
  threadId: string,
  settings: SessionExecutionSettings,
  model?: ModelSelection,
): JsonObject {
  return {
    threadId,
    approvalPolicy: mapApprovalPolicy(settings),
    approvalsReviewer: mapApprovalReviewer(settings),
    sandboxPolicy: mapSandboxPolicy(settings),
    ...(model
      ? { model: model.model, effort: model.reasoningEffort ?? null }
      : {}),
    ...mapPlanCollaborationMode(settings, model),
  }
}

export function mapTurnExecution(
  settings: SessionExecutionSettings,
  model?: ModelSelection,
): JsonObject {
  return {
    approvalPolicy: mapApprovalPolicy(settings),
    approvalsReviewer: mapApprovalReviewer(settings),
    sandboxPolicy: mapSandboxPolicy(settings),
    ...(model
      ? { model: model.model, effort: model.reasoningEffort ?? null }
      : {}),
    ...mapPlanCollaborationMode(settings, model),
  }
}

export function executionResult(
  settings: SessionExecutionSettings,
): ExecutionConfigurationResult {
  const effective = cloneSessionExecutionSettings(settings)
  const limitations: ExecutionConfigurationResult['limitations'] = []
  if (settings.approval.defaultAction === 'deny') {
    effective.approval.defaultAction = 'ask'
    limitations.push({
      capability: 'approval.defaultAction.deny',
      reason: 'Codex app-server has no deny-all AskForApproval policy',
    })
  }
  if (settings.approval.rules.length > 0) {
    limitations.push({
      capability: 'approval.rules',
      reason: 'Portable granular rules cannot be translated atomically to Codex execpolicy',
    })
  }
  if (settings.sandbox.network === 'deny') {
    effective.sandbox.network = 'ask'
    limitations.push({
      capability: 'sandbox.network.deny',
      reason: 'Codex networkAccess=false can still escalate through on-request approval',
    })
  }
  return { effective, limitations }
}

function mapApprovalPolicy(settings: SessionExecutionSettings): 'never' | 'on-request' {
  return settings.approval.defaultAction === 'allow' ? 'never' : 'on-request'
}

function mapApprovalReviewer(
  settings: SessionExecutionSettings,
): 'user' | 'auto_review' {
  return settings.approval.reviewer === 'provider' ? 'auto_review' : 'user'
}

function mapSandboxMode(
  settings: SessionExecutionSettings,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (settings.sandbox.filesystem === 'unrestricted') return 'danger-full-access'
  return settings.sandbox.filesystem
}

function mapSandboxPolicy(settings: SessionExecutionSettings): JsonObject {
  if (settings.sandbox.filesystem === 'unrestricted') {
    return { type: 'dangerFullAccess' }
  }
  const networkAccess = settings.sandbox.network === 'allow'
  if (settings.sandbox.filesystem === 'read-only') {
    return { type: 'readOnly', networkAccess }
  }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

function mapPlanCollaborationMode(
  settings: SessionExecutionSettings,
  model?: ModelSelection,
): JsonObject {
  if (settings.workMode !== 'plan') return {}
  if (!model) {
    throw new Error('Codex plan mode requires the active model selection')
  }
  return {
    collaborationMode: {
      mode: 'plan',
      settings: {
        model: model.model,
        reasoning_effort: model.reasoningEffort ?? null,
        developer_instructions: null,
      },
    },
  }
}
