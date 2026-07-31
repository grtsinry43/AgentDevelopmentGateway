import assert from 'node:assert/strict'
import test from 'node:test'
import { asSessionId, type RuntimeEvent } from '@agent-gateway/core'
import { AdapterRegistry } from '../src/adapter-registry.js'
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

test('durably admits input before delivering it to the bound adapter', async () => {
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
  claude.beforeSend = () => {
    assert.equal(persisted.at(-1)?.type, 'input.admitted')
  }

  const receipt = await manager.send(created.session.id, { text: 'Inspect the workspace' })
  const admitted = manager.eventSnapshot(created.session.id).at(-1)

  assert.equal(admitted?.type, 'input.admitted')
  if (admitted?.type !== 'input.admitted') throw new Error('Missing admitted input')
  assert.equal(admitted.sequence, receipt.admittedSequence)
  assert.equal(admitted.payload.input.text, 'Inspect the workspace')
  assert.equal(admitted.turnId, receipt.turnId)
  assert.equal(claude.sendInputs[0]?.options.turnId, receipt.turnId)

  manager.setSessionTitle(created.session.id, 'Inspect the workspace')
  assert.equal(manager.getSession(created.session.id).session.title, 'Inspect the workspace')
})

test('records a failed turn when adapter delivery rejects', async () => {
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

  await assert.rejects(manager.send(created.session.id, { text: 'Fail this turn' }), /delivery failed/)

  assert.deepEqual(
    manager.eventSnapshot(created.session.id).slice(-2).map((event) => event.type),
    ['input.admitted', 'turn.failed'],
  )
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
