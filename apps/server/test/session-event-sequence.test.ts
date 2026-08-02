import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { asSessionId, createDefaultSessionExecutionSettings } from '@agent-gateway/core'
import { AdapterRegistry, RuntimeSessionManager } from '@agent-gateway/runtime'
import { ProjectRepository } from '../src/features/projects/repository.js'
import { SessionEventRepository } from '../src/features/sessions/event-repository.js'
import { SessionItemRepository } from '../src/features/sessions/item-repository.js'
import { SessionItemizer } from '../src/features/sessions/session-itemizer.js'
import { MaterializedEventSink } from '../src/features/sessions/materialized-event-sink.js'
import { SessionRepository } from '../src/features/sessions/repository.js'
import { SessionService } from '../src/features/sessions/service.js'
import { openGatewayDatabase } from '../src/infrastructure/database.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('durable append advances sessions.last_event_sequence in the same transaction', () => {
  const database = openGatewayDatabase(':memory:')
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const events = new SessionEventRepository(database)
  const adapter = new FakeRuntimeAdapter()
  const now = Date.now()
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const hostId = randomUUID()
  const execution = createDefaultSessionExecutionSettings()

  projects.create({
    id: projectId,
    hostId,
    path: '/test/project',
    normalizedPath: '/test/project',
    name: 'Test project',
    createdAt: now,
    updatedAt: now
  })
  sessions.create({
    session: {
      id: asSessionId(sessionId),
      projectId,
      hostId,
      adapterId: 'claude-code',
      execution: { configured: execution, effective: execution, limitations: [] },
      controlRevision: 0,
      status: 'idle',
      lastEventSequence: 0,
      createdAt: now,
      updatedAt: now
    },
    capabilities: adapter.descriptor.capabilities,
    taskState: { tasks: [] },
    subagentRuns: [],
    inputQueue: []
  })

  events.append({
    id: 1,
    sequence: 7,
    sessionId: asSessionId(sessionId),
    adapterId: 'claude-code',
    timestamp: now,
    type: 'session.status_changed',
    payload: { status: 'idle' }
  })

  assert.equal(events.maxSequence(sessionId), 7)
  assert.equal(sessions.findById(sessionId)?.session.lastEventSequence, 7)
  assert.equal(events.durableCursor(sessionId, 3), 7)
  database.close()
})

test('resume repairs a stale watermark so the next durable event does not collide', async () => {
  const database = openGatewayDatabase(':memory:')
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const events = new SessionEventRepository(database)
  const items = new SessionItemRepository(database)
  const itemizer = new SessionItemizer(items, {
    listAfter: (sessionId, after) => events.listAfter(sessionId, after)
  })
  const adapter = new FakeRuntimeAdapter()
  const runtime = new RuntimeSessionManager(
    new AdapterRegistry([adapter]),
    new MaterializedEventSink(events, itemizer)
  )
  const service = new SessionService(sessions, events, items, itemizer, projects, runtime, {}, () => undefined)
  const projectId = randomUUID()
  const hostId = randomUUID()
  const now = Date.now()

  projects.create({
    id: projectId,
    hostId,
    path: '/test/project',
    normalizedPath: '/test/project',
    name: 'Test project',
    createdAt: now,
    updatedAt: now
  })

  try {
    const created = await service.create(projectId, {
      adapterId: 'claude-code',
      initialInput: { clientMessageId: randomUUID(), text: 'First turn' }
    })
    const sessionId = created.session.id
    await waitForSequence(service, sessionId, created.receipt.admittedSequence + 6)
    await service.close(sessionId, {})
    await waitForStatus(service, sessionId, 'closed')
    const maxSequence = events.maxSequence(sessionId)
    assert.ok(maxSequence > 0)

    // Simulate the crash window: event log is ahead of the session watermark.
    database
      .prepare('UPDATE sessions SET last_event_sequence = ? WHERE id = ?')
      .run(maxSequence - 1, sessionId)
    assert.equal(sessions.findById(sessionId)?.session.lastEventSequence, maxSequence - 1)
    assert.equal(events.durableCursor(sessionId, maxSequence - 1), maxSequence)

    await service.resume(sessionId, {})
    // Resume itself may append more events; the critical check is no UNIQUE collision
    // when continuing past the previously persisted max sequence.
    const beforeEmit = events.maxSequence(sessionId)
    assert.ok(beforeEmit >= maxSequence)

    adapter.emit(asSessionId(sessionId), {
      type: 'session.status_changed',
      payload: { status: 'idle' }
    })
    const after = await waitForSequence(service, sessionId, beforeEmit + 1)
    assert.ok(after.lastEventSequence >= beforeEmit + 1)
    assert.ok(events.maxSequence(sessionId) >= beforeEmit + 1)
  } finally {
    await service.shutdown()
    database.close()
  }
})

async function waitForSequence(
  service: SessionService,
  sessionId: string,
  minimum: number
): Promise<ReturnType<SessionService['get']>> {
  return waitForSession(service, sessionId, (session) => session.lastEventSequence >= minimum)
}

async function waitForStatus(
  service: SessionService,
  sessionId: string,
  status: ReturnType<SessionService['get']>['status']
): Promise<ReturnType<SessionService['get']>> {
  return waitForSession(service, sessionId, (session) => session.status === status)
}

async function waitForSession(
  service: SessionService,
  sessionId: string,
  ready: (session: ReturnType<SessionService['get']>) => boolean
): Promise<ReturnType<SessionService['get']>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = service.get(sessionId)
    if (ready(session)) return session
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for Session ${sessionId}`)
}
