import assert from 'node:assert/strict'
import test from 'node:test'
import { AdapterRegistry, RuntimeSessionManager } from '@agent-gateway/runtime'
import { ProjectRepository } from '../src/features/projects/repository.js'
import { SessionRepository } from '../src/features/sessions/repository.js'
import { SessionEventRepository } from '../src/features/sessions/event-repository.js'
import { SessionItemRepository } from '../src/features/sessions/item-repository.js'
import { SessionItemizer } from '../src/features/sessions/session-itemizer.js'
import { MaterializedEventSink } from '../src/features/sessions/materialized-event-sink.js'
import { SessionService } from '../src/features/sessions/service.js'
import { openGatewayDatabase } from '../src/infrastructure/database.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('persists runtime snapshots and interrupts live sessions on shutdown', async (t) => {
  const database = openGatewayDatabase(':memory:')
  t.after(() => database.close())
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const events = new SessionEventRepository(database)
  const items = new SessionItemRepository(database)
  const itemizer = new SessionItemizer(items, {
    listAfter: (sessionId, after) => events.listAfter(sessionId, after)
  })
  const hostId = '9d3e5ddf-b870-4728-872e-d66c32f55086'
  const projectId = 'ea8bb090-1cad-41b4-875f-a30c1c980187'
  const now = Date.now()
  projects.create({
    id: projectId,
    hostId,
    path: '/workspace/project',
    normalizedPath: '/workspace/project',
    name: 'project',
    createdAt: now,
    updatedAt: now
  })
  const adapter = new FakeRuntimeAdapter()
  const runtime = new RuntimeSessionManager(
    new AdapterRegistry([adapter]),
    new MaterializedEventSink(events, itemizer)
  )
  const observerErrors: unknown[] = []
  const service = new SessionService(sessions, events, items, itemizer, projects, runtime, {}, (error) =>
    observerErrors.push(error)
  )

  const created = await service.create(projectId, {
    adapterId: 'claude-code',
    initialInput: {
      clientMessageId: '38b8d3b3-33c3-4af9-9f16-8f78e8bf16c8',
      text: 'Inspect this project'
    }
  })
  await waitFor(() => service.get(created.session.id).status === 'idle')
  assert.equal(service.get(created.session.id).adapterId, 'claude-code')
  assert.equal(created.session.title, 'Inspect this project')
  assert.ok(events.listAfter(created.session.id).some((event) => event.type === 'input.admitted'))

  await service.shutdown()

  assert.equal(sessions.findById(created.session.id)?.session.status, 'interrupted')
  assert.equal(adapter.disposeCalls.length, 1)
  assert.deepEqual(observerErrors, [])
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for condition')
}
