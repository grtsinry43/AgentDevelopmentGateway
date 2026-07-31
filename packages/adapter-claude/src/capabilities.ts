import type { RuntimeCapabilities } from '@agent-gateway/core'
import type { SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk'

export const CLAUDE_BASE_CAPABILITIES: RuntimeCapabilities = {
  steer: 'queue-fallback',
  modelSwitch: 'in-session',
  features: {
    'session.resume': true,
    'output.partial_text': true,
    'output.partial_reasoning': true,
    'tool.input_stream': true,
    'interaction.permission': true,
    'interaction.question': true,
    'mode.plan': true,
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
