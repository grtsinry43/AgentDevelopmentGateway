import assert from 'node:assert/strict'
import test from 'node:test'
import {
  asSessionId,
  asTurnId,
  type AdapterEvent,
  type InteractionId,
} from '@agent-gateway/core'
import { ClaudeInteractionBridge } from '../src/interaction-bridge.js'

const sessionId = asSessionId('gateway-session')
const turnId = asTurnId('gateway-turn')

test('blocks a tool request until runtime allows it and maps persisted rules', async () => {
  const events: AdapterEvent[] = []
  const bridge = new ClaudeInteractionBridge(sessionId, () => turnId, (event) => events.push(event))
  const controller = new AbortController()
  const resultPromise = bridge.canUseTool(
    'Bash',
    { command: 'pwd' },
    {
      signal: controller.signal,
      toolUseID: 'tool-1',
      requestId: 'interaction-1',
      title: 'Run pwd',
    },
  )

  const request = events.find((event) => event.type === 'interaction.permission_requested')
  assert.ok(request)
  assert.equal(request.payload.request.kind, 'tool_permission')
  if (request.payload.request.kind !== 'tool_permission') throw new Error('Expected tool permission request')
  assert.equal(request.payload.request.prompt, 'Run pwd')
  assert.equal(request.payload.request.turnId, turnId)
  assert.equal(request.payload.request.toolKind, 'terminal')
  assert.equal(request.payload.request.toolName, 'Bash')
  assert.deepEqual(request.payload.request.input, { command: 'pwd' })

  bridge.resolve({
    kind: 'tool_permission',
    id: request.payload.request.id,
    decision: { behavior: 'allow', updatedInput: { command: 'pwd -P' } },
    persistRule: {
      rule: { toolName: 'Bash', ruleContent: 'pwd *' },
      destination: 'project',
    },
  })

  assert.deepEqual(await resultPromise, {
    behavior: 'allow',
    updatedInput: { command: 'pwd -P' },
    updatedPermissions: [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'pwd *' }],
      },
    ],
    toolUseID: 'tool-1',
  })
  assert.equal(events.filter((event) => event.type === 'interaction.resolved').length, 1)

  bridge.resolve({
    kind: 'tool_permission',
    id: request.payload.request.id,
    decision: { behavior: 'deny', message: 'late answer' },
  })
  assert.equal(events.filter((event) => event.type === 'interaction.resolved').length, 1)
})

test('maps AskUserQuestion answers to the SDK response shape', async () => {
  const events: AdapterEvent[] = []
  const bridge = new ClaudeInteractionBridge(sessionId, () => turnId, (event) => events.push(event))
  const resultPromise = bridge.canUseTool(
    'AskUserQuestion',
    {
      questions: [
        {
          question: 'Which runtime?',
          header: 'Runtime',
          options: [
            { label: 'Local', description: 'Run locally' },
            { label: 'Remote', description: 'Run remotely' },
          ],
          multiSelect: true,
        },
      ],
    },
    { signal: new AbortController().signal, toolUseID: 'tool-2', requestId: 'interaction-2' },
  )

  const request = events.find((event) => event.type === 'interaction.question_requested')
  assert.ok(request)
  assert.equal(request.payload.request.kind, 'question')
  if (request.payload.request.kind !== 'question') throw new Error('Expected question request')
  assert.equal(request.payload.request.questions[0]?.allowCustom, true)
  bridge.resolve({
    kind: 'question',
    id: request.payload.request.id,
    answers: { 'Which runtime?': ['Local', 'Remote'] },
  })

  assert.deepEqual(await resultPromise, {
    behavior: 'allow',
    updatedInput: {
      questions: [
        {
          question: 'Which runtime?',
          header: 'Runtime',
          options: [
            { label: 'Local', description: 'Run locally' },
            { label: 'Remote', description: 'Run remotely' },
          ],
          multiSelect: true,
        },
      ],
      answers: { 'Which runtime?': 'Local, Remote' },
    },
    toolUseID: 'tool-2',
  })
})

test('adds a proposed ChangeSet to a Write permission request', async () => {
  const events: AdapterEvent[] = []
  const bridge = new ClaudeInteractionBridge(
    sessionId,
    () => turnId,
    (event) => events.push(event),
    '/workspace',
  )
  const resultPromise = bridge.canUseTool(
    'Write',
    { file_path: '/workspace/proposed.ts', content: 'const proposed = true\n' },
    {
      signal: new AbortController().signal,
      toolUseID: 'write-preview',
      requestId: 'write-preview-request',
    },
  )
  const request = await waitForPermissionRequest(events)

  assert.equal(request.payload.request.kind, 'tool_permission')
  if (request.payload.request.kind !== 'tool_permission') throw new Error('Expected permission')
  assert.equal(request.payload.request.proposedChangeSet?.intent, 'proposed')
  assert.equal(request.payload.request.proposedChangeSet?.files[0]?.additions, 1)
  bridge.resolve({
    kind: 'tool_permission',
    id: request.payload.request.id,
    decision: { behavior: 'deny' },
  })
  await resultPromise
})

test('cancels a pending request when Claude aborts it', async () => {
  const events: AdapterEvent[] = []
  const bridge = new ClaudeInteractionBridge(sessionId, () => turnId, (event) => events.push(event))
  const controller = new AbortController()
  const resultPromise = bridge.canUseTool(
    'Write',
    { file_path: '/tmp/example' },
    { signal: controller.signal, toolUseID: 'tool-3', requestId: 'interaction-3' },
  )
  controller.abort()

  assert.deepEqual(await resultPromise, {
    behavior: 'deny',
    message: 'Claude canceled the interaction',
    toolUseID: 'tool-3',
  })
  const canceled = events.find((event) => event.type === 'interaction.canceled')
  assert.equal(canceled?.payload.id, 'interaction-3' as InteractionId)
  assert.equal(canceled?.payload.reason, 'aborted')
})

async function waitForPermissionRequest(events: AdapterEvent[]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = events.find((event) => event.type === 'interaction.permission_requested')
    if (request?.type === 'interaction.permission_requested') return request
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for permission request')
}
