import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AdapterError,
  asInteractionId,
  asSessionId,
  asSubagentRunId,
  asToolCallId,
  asTurnId,
  type RuntimeEvent,
} from '@agent-gateway/core'
import { AdapterRegistry } from '../src/adapter-registry.js'
import {
  RUNTIME_ENVIRONMENT_FRAGMENT_KEY,
  RUNTIME_ENVIRONMENT_INSTRUCTIONS,
} from '../src/runtime-environment-context.js'
import { RuntimeSessionManager } from '../src/session-manager.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

const localHost = { hostId: 'local', platform: 'darwin' }

test('binds each project session to one adapter and reuses its host connection', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const codex = new FakeRuntimeAdapter('codex')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude, codex]))

  const claudeOne = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  const claudeTwo = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  const codexOne = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'codex',
  })
  await waitForEvents(manager, claudeOne.session.id, 2)
  await waitForEvents(manager, claudeTwo.session.id, 2)
  await waitForEvents(manager, codexOne.session.id, 2)

  assert.equal(claude.connectCount, 1)
  assert.equal(codex.connectCount, 1)
  assert.equal(manager.getSession(claudeOne.session.id).session.adapterId, 'claude-code')
  assert.equal(manager.getSession(codexOne.session.id).session.adapterId, 'codex')
  assert.equal(manager.listSessions('project-1').length, 3)

  const eventIds = [claudeOne, claudeTwo, codexOne].flatMap((created) =>
    manager.eventSnapshot(created.session.id).map((event) => event.id),
  )
  assert.equal(new Set(eventIds).size, eventIds.length)

  claudeOne.session.adapterId = 'opencode'
  assert.equal(manager.getSession(claudeOne.session.id).session.adapterId, 'claude-code')
})

test('requires explicit installation selection when a runtime has multiple installations', async () => {
  const claude = new FakeRuntimeAdapter('claude-code', [
    { path: '/runtime/one', source: 'path' },
    { path: '/runtime/two', source: 'custom' },
  ])
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const input = {
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code' as const,
  }

  await assert.rejects(manager.createSession(input), /select one explicitly/)
  const created = await manager.createSession({ ...input, installationPath: '/runtime/two' })

  assert.equal(created.session.adapterId, 'claude-code')
  assert.equal(claude.connectCount, 1)
})

test('lists provider models before creation and through the active session connection', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const catalog = await manager.listModels({
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  assert.equal(catalog.models[0]?.id, 'test-model')

  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  assert.deepEqual(await manager.listSessionModels(created.session.id), catalog)
  assert.equal(claude.connectCount, 1)
  assert.equal(claude.listModelsInputs.length, 1)
})

test('uses an active session when no cached model catalog exists', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })

  await manager.listSessionModels(created.session.id)

  assert.equal(claude.listModelsInputs.length, 1)
  assert.equal(claude.listModelsInputs[0]?.sessionId, created.session.id)
})

test('deduplicates in-flight model catalogs and does not cache failures', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  claude.beforeListModels = () => gate
  const input = {
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code' as const,
  }

  const first = manager.listModels(input)
  const second = manager.listModels(input)
  release()
  await Promise.all([first, second])
  assert.equal(claude.listModelsInputs.length, 1)

  const otherProject = { ...input, projectPath: '/workspace/other' }
  claude.beforeListModels = undefined
  claude.listModelsError = new Error('catalog unavailable')
  await assert.rejects(manager.listModels(otherProject), /catalog unavailable/)
  claude.listModelsError = undefined
  await manager.listModels(otherProject)
  assert.equal(claude.listModelsInputs.length, 3)
})

test('seals adapter events with immutable routing and monotonic cursors', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)

  claude.emit(created.session.id, {
    type: 'session.title_changed',
    payload: { title: 'Runtime-owned title', source: 'provider' },
  })
  await waitForEvents(manager, created.session.id, 3)
  const events = manager.eventSnapshot(created.session.id)

  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3],
  )
  assert.ok(events.every((event) => event.sessionId === created.session.id))
  assert.ok(events.every((event) => event.adapterId === 'claude-code'))
  assert.equal(manager.getSession(created.session.id).session.title, 'Runtime-owned title')
  assert.equal(manager.getSession(created.session.id).session.lastEventSequence, 3)
})

test('persists provider-neutral ChangeSet snapshots without rewriting their payload', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const persisted: RuntimeEvent[] = []
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]), {
    append: (event) => persisted.push(event),
    discardSession: () => undefined,
  })
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)
  const toolCallId = asToolCallId('edit-1')
  const turnId = asTurnId('turn-1')
  claude.emit(created.session.id, {
    type: 'changes.updated',
    turnId,
    payload: {
      changeSet: {
        id: 'tool:edit-1',
        intent: 'applied',
        scope: 'tool',
        status: 'completed',
        toolCallId,
        files: [
          {
            path: 'src/example.ts',
            pathKind: 'workspace-relative',
            kind: 'modify',
            additions: 1,
            deletions: 1,
            hunks: [],
          },
        ],
      },
    },
  })
  await waitForEvents(manager, created.session.id, 3)

  const event = manager.eventSnapshot(created.session.id).at(-1)
  assert.equal(event?.type, 'changes.updated')
  if (event?.type !== 'changes.updated') throw new Error('Missing persisted ChangeSet')
  assert.equal(event.turnId, turnId)
  assert.equal(event.payload.changeSet.toolCallId, toolCallId)
  assert.deepEqual(persisted.at(-1), event)
})

test('reduces provider-neutral task snapshots, patches and dependency relations', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)

  claude.emit(created.session.id, {
    type: 'task.updated',
    payload: {
      update: {
        kind: 'replace',
        tasks: [
          { id: 'task-1', title: 'Design contract', status: 'completed' },
          { id: 'task-2', title: 'Build panel', status: 'pending' },
        ],
      },
    },
  })
  claude.emit(created.session.id, {
    type: 'task.updated',
    payload: {
      update: {
        kind: 'patch',
        id: 'task-2',
        changes: { status: 'in_progress', activeText: 'Building panel' },
        append: { blockedBy: ['task-1'], blocks: ['task-3', 'task-3'] },
      },
    },
  })
  await waitForEvents(manager, created.session.id, 4)

  const state = manager.getSession(created.session.id).taskState
  assert.equal(state.tasks[1]?.status, 'in_progress')
  assert.equal(state.tasks[1]?.activeText, 'Building panel')
  assert.deepEqual(state.tasks[1]?.blockedBy, ['task-1'])
  assert.deepEqual(state.tasks[1]?.blocks, ['task-3'])

  state.tasks[1]?.blockedBy?.push('mutated-outside-runtime')
  assert.deepEqual(manager.getSession(created.session.id).taskState.tasks[1]?.blockedBy, ['task-1'])
})

test('durably admits input before delivering it to the bound adapter', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  claude.sendResult = {
    providerReceipt: {
      providerInputId: 'provider-message-17',
      providerSequence: 9_001,
      raw: { accepted: true },
    },
  }
  const persisted: RuntimeEvent[] = []
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]), {
    append: (event) => persisted.push(event),
    discardSession: () => undefined,
  })
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)
  claude.beforeSend = () => {
    assert.deepEqual(
      persisted.slice(-2).map((event) => event.type),
      ['input.admitted', 'input.queue_updated'],
    )
  }

  const receipt = await manager.send(created.session.id, {
    clientMessageId: 'message-1',
    text: 'Inspect the workspace',
  })
  await waitForAdapterSends(claude, 1)
  const events = manager.eventSnapshot(created.session.id)
  const admitted = events.find((event) => event.type === 'input.admitted')
  const dispatched = events.find((event) => event.type === 'input.dispatched')

  assert.equal(admitted?.type, 'input.admitted')
  if (admitted?.type !== 'input.admitted') throw new Error('Missing admitted input')
  assert.equal(admitted.sequence, receipt.admittedSequence)
  assert.equal(admitted.payload.entry.input.text, 'Inspect the workspace')
  assert.equal(dispatched?.type, 'input.dispatched')
  if (dispatched?.type !== 'input.dispatched') throw new Error('Missing dispatched input')
  assert.equal(dispatched.payload.entry.turnId, claude.sendInputs[0]?.options.turnId)
  assert.equal(dispatched.payload.entry.admittedSequence, receipt.admittedSequence)
  assert.notEqual(dispatched.payload.entry.admittedSequence, 9_001)
  assert.deepEqual(dispatched.payload.entry.providerReceipt, claude.sendResult.providerReceipt)
  assert.equal(claude.sendInputs[0]?.options.kind, 'start-turn')

  manager.setSessionTitle(created.session.id, 'Inspect the workspace')
  assert.equal(manager.getSession(created.session.id).session.title, 'Inspect the workspace')
})

test('keeps admitOnly input in Gateway without calling the adapter', async () => {
  const opencode = new FakeRuntimeAdapter('opencode')
  const manager = new RuntimeSessionManager(new AdapterRegistry([opencode]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'opencode',
  })
  await waitForEvents(manager, created.session.id, 2)

  await manager.send(created.session.id, {
    clientMessageId: 'admit-only',
    text: 'Store without provider delivery',
    admitOnly: true,
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(opencode.sendInputs.length, 0)
  assert.equal(manager.getSession(created.session.id).inputQueue[0]?.status, 'pending')
  assert.equal(manager.getSession(created.session.id).inputQueue[0]?.input.admitOnly, true)
})

test('records failed input delivery after durable admission', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)
  claude.sendError = new Error('delivery failed')

  await manager.send(created.session.id, { clientMessageId: 'message-fail', text: 'Fail this turn' })
  await waitForEventType(manager, created.session.id, 'input.failed')

  assert.deepEqual(
    manager.eventSnapshot(created.session.id).slice(-4).map((event) => event.type),
    ['input.admitted', 'input.queue_updated', 'input.failed', 'input.queue_updated'],
  )
})

test('queues follow-ups while running and dispatches native steers into the active turn', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  claude.descriptor.capabilities.steer = 'native'
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)

  await manager.send(created.session.id, { clientMessageId: 'initial', text: 'Start work' })
  await waitForAdapterSends(claude, 1)
  const activeTurnId = claude.sendInputs[0]?.options.turnId
  assert.ok(activeTurnId)
  claude.emit(created.session.id, {
    type: 'turn.started',
    payload: { turnId: activeTurnId },
    turnId: activeTurnId,
  })
  claude.emit(created.session.id, {
    type: 'session.status_changed',
    payload: { status: 'running' },
    turnId: activeTurnId,
  })
  await waitForStatusValue(manager, created.session.id, 'running')

  await manager.send(created.session.id, { clientMessageId: 'queued', text: 'Run after this' })
  await manager.send(created.session.id, {
    clientMessageId: 'steer',
    text: 'Prioritize tests',
    delivery: 'steer',
  })
  await waitForAdapterSends(claude, 2)
  assert.equal(claude.sendInputs[1]?.options.kind, 'steer')
  assert.equal(claude.sendInputs[1]?.options.turnId, activeTurnId)
  assert.deepEqual(manager.getSession(created.session.id).inputQueue.map((entry) => entry.id), ['queued'])

  claude.emit(created.session.id, {
    type: 'turn.completed',
    payload: { turnId: activeTurnId, status: 'completed' },
    turnId: activeTurnId,
  })
  claude.emit(created.session.id, {
    type: 'session.status_changed',
    payload: { status: 'idle' },
    turnId: activeTurnId,
  })
  await waitForAdapterSends(claude, 3)
  assert.equal(claude.sendInputs[2]?.input.clientMessageId, 'queued')
  assert.equal(claude.sendInputs[2]?.options.kind, 'start-turn')
  assert.deepEqual(manager.getSession(created.session.id).inputQueue, [])
})

test('projects complete subagent state snapshots independently from transcript events', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)
  const runId = asSubagentRunId('subagent-1')
  const startedAt = Date.now()
  claude.emit(created.session.id, {
    type: 'subagent.started',
    payload: {
      run: {
        id: runId,
        sessionId: created.session.id,
        runtimeSubagentId: 'native-task-1',
        title: 'Inspect runtime',
        agentName: 'explorer',
        executionMode: 'background',
        status: 'running',
        startedAt,
        updatedAt: startedAt,
      },
    },
  })
  await waitForEventType(manager, created.session.id, 'subagent.started')
  const projected = manager.getSession(created.session.id).subagentRuns[0]
  assert.equal(projected?.runtimeSubagentId, 'native-task-1')
  projected!.title = 'mutated outside runtime'
  assert.equal(manager.getSession(created.session.id).subagentRuns[0]?.title, 'Inspect runtime')
})

test('cleans up failed creation and transitions a failed event pump to error', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  claude.createError = new Error('create failed')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const input = {
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code' as const,
  }

  await assert.rejects(manager.createSession(input), /create failed/)
  assert.equal(manager.listSessions().length, 0)

  claude.createError = undefined
  const created = await manager.createSession(input)
  await waitForEvents(manager, created.session.id, 2)
  claude.failEvents(created.session.id, new Error('event pump failed'))
  await waitForStatus(manager, created.session.id, 'error')

  assert.equal(manager.getSession(created.session.id).session.status, 'error')
  assert.equal(manager.eventSnapshot(created.session.id).at(-1)?.type, 'runtime.error')

  await manager.disposeSession(created.session.id)
  assert.equal(manager.getSession(created.session.id).session.status, 'closed')
})

test('disposes only the adapter bound to the session and closes its event stream', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const codex = new FakeRuntimeAdapter('codex')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude, codex]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)

  await manager.disposeSession(created.session.id)

  assert.deepEqual(claude.disposeCalls, [created.session.id])
  assert.deepEqual(codex.disposeCalls, [])
  assert.equal(manager.getSession(created.session.id).session.status, 'closed')
  const replay = []
  for await (const event of manager.events(created.session.id)) replay.push(event)
  const lastEvent = replay.at(-1)
  assert.equal(lastEvent?.type, 'session.status_changed')
  if (lastEvent?.type !== 'session.status_changed') throw new Error('Missing closed status event')
  assert.equal(lastEvent.payload.status, 'closed')
})

test('registers and forwards server requests independently for multiple adapters', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const codex = new FakeRuntimeAdapter('codex')
  const requests: string[] = []
  const manager = new RuntimeSessionManager(
    new AdapterRegistry([claude, codex]),
    undefined,
    async (request) => {
      requests.push(`${request.method}:${request.id}`)
      if (request.method === 'codex.fail') throw new Error('host handler failed')
      return { id: request.id, result: { handled: request.method } }
    },
  )
  const claudeRequest = {
    id: 'request-claude',
    sessionId: asSessionId('session-claude'),
    method: 'claude.time',
    params: {},
  }
  const codexRequest = {
    id: 'request-codex',
    sessionId: asSessionId('session-codex'),
    method: 'codex.dynamicTool.call',
    params: { tool: 'lookup' },
  }

  assert.deepEqual(await claude.emitServerRequest(claudeRequest), {
    id: claudeRequest.id,
    result: { handled: claudeRequest.method },
  })
  assert.deepEqual(await codex.emitServerRequest(codexRequest), {
    id: codexRequest.id,
    result: { handled: codexRequest.method },
  })
  await assert.rejects(
    codex.emitServerRequest({ ...codexRequest, id: 'request-fail', method: 'codex.fail' }),
    /host handler failed/,
  )
  assert.deepEqual(requests, [
    'claude.time:request-claude',
    'codex.dynamicTool.call:request-codex',
    'codex.fail:request-fail',
  ])

  await manager.disposeAllSessions()
  assert.equal(claude.serverRequestRegistrationCount, 0)
  assert.equal(codex.serverRequestRegistrationCount, 0)
  assert.equal(claude.serverRequestRegistrationDisposals, 1)
  assert.equal(codex.serverRequestRegistrationDisposals, 1)
})

test('rejects server requests explicitly when no host handler is configured', async () => {
  const codex = new FakeRuntimeAdapter('codex')
  const manager = new RuntimeSessionManager(new AdapterRegistry([codex]))

  await assert.rejects(
    codex.emitServerRequest({
      id: 'request-unconfigured',
      sessionId: asSessionId('session-codex'),
      method: 'codex.attestation',
      params: {},
    }),
    (error: unknown) =>
      error instanceof AdapterError &&
      error.runtimeError.code === 'not_implemented' &&
      error.runtimeError.nativeCode === 'gateway.server_request.handler_not_configured',
  )

  await manager.disposeAllSessions()
})

test('attempts to dispose every session when one adapter disposal fails', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const first = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  const second = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, first.session.id, 2)
  await waitForEvents(manager, second.session.id, 2)
  claude.disposeFailures.add(first.session.id)

  await assert.rejects(manager.disposeAllSessions(), /Failed to dispose 1 Runtime session/)

  assert.deepEqual(new Set(claude.disposeCalls), new Set([first.session.id, second.session.id]))
  assert.equal(manager.getSession(first.session.id).session.status, 'error')
  assert.equal(manager.getSession(second.session.id).session.status, 'closed')
})

test('serializes control changes, rejects stale revisions, and deduplicates client input', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  await waitForEvents(manager, created.session.id, 2)

  const mode = await manager.setWorkMode(created.session.id, 'plan', { expectedRevision: 0 })
  assert.equal(mode.controlRevision, 1)
  assert.equal(claude.executionSettings.at(-1)?.workMode, 'plan')
  await assert.rejects(
    manager.setWorkMode(created.session.id, 'build', { expectedRevision: 0 }),
    /revision is 1, expected 0/,
  )

  const model = await manager.setModel(
    created.session.id,
    { model: 'test-model', reasoningEffort: 'medium' },
    { expectedRevision: 1 },
  )
  assert.equal(model.controlRevision, 2)
  const modelEvents = manager
    .eventSnapshot(created.session.id)
    .filter((event) => event.type === 'session.model_changed')
  assert.equal(modelEvents.length, 1)
  assert.deepEqual(modelEvents[0]?.payload, {
    model: { model: 'test-model', reasoningEffort: 'medium' },
    controlRevision: 2,
  })

  const input = { clientMessageId: 'deduplicated', text: 'Run once' }
  const first = await manager.send(created.session.id, input)
  const duplicate = await manager.send(created.session.id, input)
  assert.deepEqual(duplicate, first)
  await waitForAdapterSends(claude, 1)
  assert.equal(claude.sendInputs.length, 1)
})

test('projects pending interactions and resumes event sequences without collision', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))
  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
    model: { model: 'test-model', reasoningEffort: 'medium' },
  })
  await waitForEvents(manager, created.session.id, 2)
  const interactionId = asInteractionId('interaction-1')
  claude.emit(created.session.id, {
    type: 'interaction.permission_requested',
    payload: {
      request: {
        id: interactionId,
        kind: 'tool_permission',
        sessionId: created.session.id,
        toolCallId: asToolCallId('tool-1'),
        createdAt: Date.now(),
        toolKind: 'terminal',
        toolName: 'Bash',
        input: { command: 'pwd' },
        prompt: 'Allow tool?',
      },
    },
  })
  await waitForEvents(manager, created.session.id, 3)
  assert.equal(manager.getSession(created.session.id).pendingInteractions.length, 1)
  await manager.resolveInteraction(created.session.id, {
    kind: 'tool_permission',
    id: interactionId,
    decision: { behavior: 'allow' },
  })
  await waitForEvents(manager, created.session.id, 4)
  assert.equal(manager.getSession(created.session.id).pendingInteractions.length, 0)

  await manager.disposeSession(created.session.id)
  const closed = manager.getSession(created.session.id).session
  const resumed = await manager.resumeSession({
    sessionId: closed.id,
    previousSession: closed,
    projectId: closed.projectId,
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: closed.adapterId,
    model: closed.model,
    runtimeSessionId: closed.runtimeSessionId!,
    execution: closed.execution.configured,
    taskState: manager.getSession(created.session.id).taskState,
    subagentRuns: [],
    inputQueue: [],
    inputAdmissions: [],
  })
  await waitForLastSequence(manager, resumed.session.id, closed.lastEventSequence + 2)
  const resumedEvents = manager.eventSnapshot(resumed.session.id)
  assert.ok(resumedEvents.every((event) => event.sequence > closed.lastEventSequence))

  const forked = await manager.forkSession({ sourceSessionId: resumed.session.id })
  assert.equal(forked.session.forkedFromSessionId, resumed.session.id)
  assert.deepEqual(claude.resumeInputs.at(-1)?.model, closed.model)
  assert.deepEqual(claude.forkInputs.at(-1)?.model, closed.model)
})

test('injects runtime environment SessionContext when session_injection is supported', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  claude.descriptor.capabilities.features['context.session_injection'] = true
  const manager = new RuntimeSessionManager(new AdapterRegistry([claude]))

  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'claude-code',
  })
  const createContext = claude.createInputs[0]?.context
  assert.ok(createContext)
  assert.equal(createContext.fragments[0]?.key, RUNTIME_ENVIRONMENT_FRAGMENT_KEY)
  assert.equal(createContext.fragments[0]?.content, RUNTIME_ENVIRONMENT_INSTRUCTIONS)
  assert.equal(createContext.fragments[0]?.role, 'instruction')
  assert.equal(createContext.fragments[0]?.trust, 'application')
  assert.equal(
    created.capabilities.degradations?.some((entry) => entry.capability === 'context.session_injection') ?? false,
    false,
  )

  await manager.disposeSession(created.session.id)
  const closed = manager.getSession(created.session.id).session
  const resumed = await manager.resumeSession({
    sessionId: closed.id,
    previousSession: closed,
    projectId: closed.projectId,
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: closed.adapterId,
    runtimeSessionId: closed.runtimeSessionId!,
    execution: closed.execution.configured,
    taskState: manager.getSession(created.session.id).taskState,
    subagentRuns: [],
    inputQueue: [],
    inputAdmissions: [],
  })
  assert.equal(
    claude.resumeInputs.at(-1)?.context?.fragments[0]?.key,
    RUNTIME_ENVIRONMENT_FRAGMENT_KEY,
  )

  const forked = await manager.forkSession({ sourceSessionId: resumed.session.id })
  assert.equal(
    claude.forkInputs.at(-1)?.context?.fragments[0]?.content,
    RUNTIME_ENVIRONMENT_INSTRUCTIONS,
  )
  assert.equal(forked.session.forkedFromSessionId, resumed.session.id)
})

test('skips runtime environment SessionContext and records degradation when unsupported', async () => {
  const opencode = new FakeRuntimeAdapter('opencode')
  const manager = new RuntimeSessionManager(new AdapterRegistry([opencode]))

  const created = await manager.createSession({
    projectId: 'project-1',
    host: localHost,
    projectPath: '/workspace/project',
    adapterId: 'opencode',
  })

  assert.equal(opencode.createInputs[0]?.context, undefined)
  assert.deepEqual(created.capabilities.degradations, [
    {
      capability: 'context.session_injection',
      status: 'unsupported',
      reason:
        'Runtime environment instructions were skipped because this adapter does not support context.session_injection',
    },
  ])
  assert.deepEqual(created.connection.capabilities.degradations, created.capabilities.degradations)
})

async function waitForEvents(
  manager: RuntimeSessionManager,
  sessionId: ReturnType<typeof asSessionId>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.eventSnapshot(sessionId).length >= count) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${count} events`)
}

async function waitForAdapterSends(adapter: FakeRuntimeAdapter, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (adapter.sendInputs.length >= count) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${count} adapter sends`)
}

async function waitForEventType(
  manager: RuntimeSessionManager,
  sessionId: ReturnType<typeof asSessionId>,
  type: RuntimeEvent['type'],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.eventSnapshot(sessionId).some((event) => event.type === type)) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for event ${type}`)
}

async function waitForStatus(
  manager: RuntimeSessionManager,
  sessionId: ReturnType<typeof asSessionId>,
  status: 'error',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getSession(sessionId).session.status === status) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for session status ${status}`)
}

async function waitForStatusValue(
  manager: RuntimeSessionManager,
  sessionId: ReturnType<typeof asSessionId>,
  status: 'running' | 'idle',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getSession(sessionId).session.status === status) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for session status ${status}`)
}

async function waitForLastSequence(
  manager: RuntimeSessionManager,
  sessionId: ReturnType<typeof asSessionId>,
  sequence: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getSession(sessionId).session.lastEventSequence >= sequence) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for event sequence ${sequence}`)
}
