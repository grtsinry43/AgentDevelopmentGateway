import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  asSessionId,
  asTurnId,
  type SessionExecutionSettings,
} from '@agent-gateway/core'
import { CodexAdapter } from '../src/codex-adapter.js'
import {
  createFakeCodex,
  fakeCodexEnv,
  waitForJson,
} from './support/fake-codex.js'

test('maps context, inputs, execution settings, and non-human server requests', async (t) => {
  const executable = await createFakeCodex(t)
  const observationPath = join(dirname(executable), 'adapter-contract.json')
  const adapter = new CodexAdapter()
  t.after(() => adapter.dispose())
  const hostRequests: Array<{ method: string; params: unknown }> = []
  adapter.onServerRequest((request) => {
    hostRequests.push({ method: request.method, params: request.params })
    return Promise.resolve({
      id: request.id,
      result: {
        contentItems: [{ type: 'inputText', text: 'handled by host' }],
        success: true,
      },
    })
  })
  const connection = await adapter.connect({
    context: {
      hostId: 'local',
      env: fakeCodexEnv('adapter-contract', { observationPath }),
    },
    installation: { path: executable, version: 'test', source: 'custom' },
  })
  const sessionId = asSessionId('adapter-contract')
  await adapter.createSession({
    sessionId,
    projectPath: '/workspace/project',
    connection,
    context: {
      snapshotId: 'snapshot-1',
      revision: 1,
      digest: 'session-digest',
      fragments: [{
        key: 'repo-rules',
        content: 'Use the repository rules.',
        role: 'instruction',
        trust: 'application',
        source: { kind: 'repository-instructions', path: 'AGENTS.md' },
        digest: 'fragment-digest',
      }],
    },
  })

  await adapter.setModel(sessionId, { model: 'gpt-contract', reasoningEffort: 'high' })
  const execution: SessionExecutionSettings = {
    workMode: 'plan',
    approval: {
      defaultAction: 'deny',
      reviewer: 'provider',
      rules: [{ id: 'rule-1', action: 'deny', toolKind: 'network' }],
    },
    sandbox: { filesystem: 'read-only', network: 'deny' },
  }
  const configured = await adapter.configureExecution(sessionId, execution)
  assert.equal(configured.effective.approval.defaultAction, 'ask')
  assert.deepEqual(
    configured.limitations.map((limitation) => limitation.capability),
    ['approval.defaultAction.deny', 'approval.rules', 'sandbox.network.deny'],
  )

  await adapter.send(
    sessionId,
    {
      clientMessageId: 'client-message',
      text: 'Inspect these files',
      attachments: [
        { kind: 'file', path: '/workspace/project/src/index.ts' },
        { kind: 'image', path: '/workspace/project/screenshot.png' },
      ],
    },
    {
      turnId: asTurnId('gateway-turn'),
      kind: 'start-turn',
      context: {
        fragments: [
          {
            key: 'memory:trusted',
            content: 'Application context',
            role: 'instruction',
            trust: 'application',
            source: { kind: 'memory', id: 'trusted' },
            digest: 'trusted-digest',
          },
          {
            key: 'retrieval:untrusted',
            content: 'Retrieved context',
            role: 'reference',
            trust: 'untrusted',
            source: { kind: 'retrieved-context', id: 'untrusted' },
            digest: 'untrusted-digest',
          },
        ],
      },
    },
  )

  const observations = await waitForJson<Array<Record<string, unknown>>>(observationPath)
  const threadStart = observations.find((value) => value.method === 'thread/start')
  assert.equal(
    (threadStart?.params as Record<string, unknown>).developerInstructions,
    '<gateway-context key="repo-rules">\nUse the repository rules.\n</gateway-context>',
  )
  const settingsUpdates = observations.filter(
    (value) => value.method === 'thread/settings/update',
  )
  const modelUpdateParams = settingsUpdates[0]?.params as Record<string, unknown>
  assert.equal(modelUpdateParams.model, 'gpt-contract')
  assert.equal(
    modelUpdateParams.collaborationMode,
    undefined,
    'build mode must not override the thread instructions with a fabricated collaboration mode',
  )
  const configuredParams = settingsUpdates.at(-1)?.params as Record<string, unknown>
  assert.equal(configuredParams.approvalPolicy, 'on-request')
  assert.equal(configuredParams.approvalsReviewer, 'auto_review')
  assert.deepEqual(configuredParams.sandboxPolicy, {
    type: 'readOnly',
    networkAccess: false,
  })
  assert.deepEqual(configuredParams.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-contract',
      reasoning_effort: 'high',
      developer_instructions: null,
    },
  })

  const turnStart = observations.find((value) => value.method === 'turn/start')
  const turnParams = turnStart?.params as Record<string, unknown>
  assert.deepEqual(turnParams.input, [
    { type: 'text', text: 'Inspect these files', text_elements: [] },
    { type: 'mention', name: 'index.ts', path: '/workspace/project/src/index.ts' },
    { type: 'localImage', path: '/workspace/project/screenshot.png' },
  ])
  assert.deepEqual(turnParams.additionalContext, {
    'memory:trusted': { value: 'Application context', kind: 'application' },
    'retrieval:untrusted': { value: 'Retrieved context', kind: 'untrusted' },
  })
  assert.equal(hostRequests[0]?.method, 'codex.dynamicTool.call')
  assert.equal(hostRequests[1]?.method, 'codex.attestation.generate')
  const hostResponse = observations.find((value) => 'hostResponse' in value)
  assert.deepEqual(hostResponse?.hostResponse, {
    id: 'host-dynamic-1',
    result: {
      contentItems: [{ type: 'inputText', text: 'handled by host' }],
      success: true,
    },
  })
  const attestationResponse = observations.find((value) => 'attestationResponse' in value)
  assert.deepEqual(attestationResponse?.attestationResponse, {
    id: 77,
    result: {
      contentItems: [{ type: 'inputText', text: 'handled by host' }],
      success: true,
    },
  })

  const capabilities = await adapter.getCapabilities()
  assert.equal(capabilities.features['task.todo'], true)
  assert.equal(capabilities.features['context.turn_injection'], true)
  assert.equal(capabilities.features['mcp.dynamic'], true)
})

test('rejects inline attachment data explicitly', async (t) => {
  const executable = await createFakeCodex(t)
  const adapter = new CodexAdapter()
  t.after(() => adapter.dispose())
  const connection = await adapter.connect({
    context: { hostId: 'local', env: fakeCodexEnv('adapter-contract') },
    installation: { path: executable, version: 'test', source: 'custom' },
  })
  const sessionId = asSessionId('inline-data')
  await adapter.createSession({
    sessionId,
    projectPath: '/workspace/project',
    connection,
  })
  await assert.rejects(
    adapter.send(
      sessionId,
      {
        clientMessageId: 'inline',
        text: '',
        attachments: [{ kind: 'image', data: 'aW1hZ2U=' }],
      },
      { turnId: asTurnId('inline-turn'), kind: 'start-turn' },
    ),
    /cannot represent inline attachment data/,
  )
})
