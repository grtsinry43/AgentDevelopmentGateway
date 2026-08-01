import type { RuntimeCapabilities } from '@agent-gateway/core'
import type { SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk'

export const CLAUDE_BASE_CAPABILITIES: RuntimeCapabilities = {
  steer: 'queue-fallback',
  modelSwitch: 'in-session',
  execution: {
    workModes: ['build', 'plan'],
    approvalActions: ['allow', 'ask', 'deny'],
    approvalReviewers: ['user', 'provider'],
    filesystemSandbox: ['read-only', 'workspace-write', 'unrestricted'],
    networkAccess: ['deny', 'ask', 'allow'],
    update: 'in-session',
    granularRules: true,
  },
  features: {
    'session.resume': true,
    'model.catalog': true,
    'output.partial_text': true,
    'output.partial_reasoning': true,
    'tool.input_stream': true,
    'interaction.permission': true,
    'interaction.question': true,
    'work-mode.plan': true,
    'task.todo': true,
  },
  raw: [],
}

/** Build the initial capability snapshot from Claude's authoritative init message. */
export function capabilitiesFromInit(message: SDKSystemMessage): RuntimeCapabilities {
  return {
    ...CLAUDE_BASE_CAPABILITIES,
    features: { ...CLAUDE_BASE_CAPABILITIES.features },
    raw: [...(message.capabilities ?? [])],
  }
}
