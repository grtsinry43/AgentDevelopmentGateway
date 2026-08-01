import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDefaultSessionExecutionSettings,
  type SessionExecutionSettings,
} from '@agent-gateway/core'
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import {
  evaluateClaudeToolRequest,
  resolveClaudeExecution,
} from '../src/execution-policy.js'

test('maps portable execution settings to Claude permission modes', () => {
  const standard = createDefaultSessionExecutionSettings()
  assert.equal(resolveClaudeExecution(standard).permissionMode, 'default')

  const plan = settings({ workMode: 'plan' })
  assert.equal(resolveClaudeExecution(plan).permissionMode, 'plan')

  const denied = settings({ approval: { ...standard.approval, defaultAction: 'deny' } })
  assert.equal(resolveClaudeExecution(denied).permissionMode, 'dontAsk')

  const providerReviewed = settings({
    approval: { ...standard.approval, reviewer: 'provider' },
  })
  assert.equal(resolveClaudeExecution(providerReviewed).permissionMode, 'auto')

  const unrestricted = settings({
    approval: { ...standard.approval, defaultAction: 'allow' },
    sandbox: { filesystem: 'unrestricted', network: 'allow' },
  })
  assert.equal(resolveClaudeExecution(unrestricted).permissionMode, 'bypassPermissions')

  const acceptEdits = settings({
    approval: {
      ...standard.approval,
      rules: [{ id: 'allow-writes', action: 'allow', toolKind: 'write' }],
    },
  })
  assert.equal(resolveClaudeExecution(acceptEdits).permissionMode, 'acceptEdits')
})

test('enforces sandbox boundaries before ordered permission rules', () => {
  const configured = settings({
    approval: {
      defaultAction: 'ask',
      reviewer: 'user',
      rules: [
        { id: 'allow-edit', action: 'allow', toolKind: 'write' },
        {
          id: 'deny-secret',
          action: 'deny',
          tool: 'Edit',
          resource: { kind: 'path', pattern: '*/secret/*' },
        },
      ],
    },
  })

  assert.equal(
    evaluateClaudeToolRequest(configured, hook('Edit', { file_path: '/workspace/src/app.ts' }), '/workspace'),
    'allow',
  )
  assert.equal(
    evaluateClaudeToolRequest(
      configured,
      hook('Edit', { file_path: '/workspace/secret/token.ts' }),
      '/workspace',
    ),
    'deny',
  )
  assert.equal(
    evaluateClaudeToolRequest(configured, hook('Edit', { file_path: '/outside/app.ts' }), '/workspace'),
    'deny',
  )
  assert.equal(
    evaluateClaudeToolRequest(configured, hook('Edit', { file_path: '../outside/app.ts' }), '/workspace'),
    'deny',
  )
  assert.equal(
    evaluateClaudeToolRequest(configured, hook('WebFetch', { url: 'https://example.com' }), '/workspace'),
    'ask',
  )
})

function settings(overrides: Partial<SessionExecutionSettings>): SessionExecutionSettings {
  const defaults = createDefaultSessionExecutionSettings()
  return {
    ...defaults,
    ...overrides,
    approval: overrides.approval ?? defaults.approval,
    sandbox: overrides.sandbox ?? defaults.sandbox,
  }
}

function hook(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/workspace',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-use',
  }
}
