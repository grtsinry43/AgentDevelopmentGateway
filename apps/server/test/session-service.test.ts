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

test('itemsWindow tail page keeps the newest materialized item', async (t) => {
  const database = openGatewayDatabase(':memory:')
  t.after(() => database.close())
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const events = new SessionEventRepository(database)
  const items = new SessionItemRepository(database)
  const itemizer = new SessionItemizer(items, {
    listAfter: (sessionId, after) => events.listAfter(sessionId, after)
  })
  const sink = new MaterializedEventSink(events, itemizer)
  const projectId = 'e4f0a9a1-7b2c-4d3e-9f8a-0c1d2e3f4a5b'
  const now = Date.now()
  projects.create({
    id: projectId,
    hostId: '9d3e5ddf-b870-4728-872e-d66c32f55086',
    path: '/workspace/project',
    normalizedPath: '/workspace/project',
    name: 'project',
    createdAt: now,
    updatedAt: now
  })
  const runtime = new RuntimeSessionManager(
    new AdapterRegistry([new FakeRuntimeAdapter()]),
    sink
  )
  const service = new SessionService(sessions, events, items, itemizer, projects, runtime, {}, () => {})
  const created = await service.create(projectId, {
    adapterId: 'claude-code',
    initialInput: { clientMessageId: '59f34a10-9b8c-4d2e-9f11-aa22bb33cc44', text: 'start' }
  })
  const sessionId = created.session.id

  // 追加超过 limit 的成品消息(每条 input.dispatched = 一条 message item)。
  // 序号必须高于 itemizer 的 lastSequence(live-only 增量事件序号可能高于 durable max)。
  const limit = 10
  const extra = limit + 3
  const before = items.listBefore(sessionId, Number.MAX_SAFE_INTEGER, 10000).length
  let seq = events.maxSequence(sessionId) + 1000
  for (let i = 0; i < extra; i += 1) {
    seq += 1
    sink.append({
      id: seq,
      sequence: seq,
      sessionId,
      adapterId: 'claude-code',
      timestamp: now + seq,
      type: 'input.dispatched',
      payload: {
        entry: {
          id: `c-${i}`,
          input: { text: `msg ${i}`, clientMessageId: `c-${i}` },
          requestedDelivery: 'steer',
          status: 'delivered',
          admittedSequence: seq,
          createdAt: now + seq,
          updatedAt: now + seq
        }
      }
    })
  }

  // 尾页必须包含最新一条,而不是把它丢给 hasMore 探查。
  const tail = service.itemsWindow(sessionId, undefined, limit)
  assert.equal(tail.hasMore, true)
  assert.equal(tail.items.length, limit)
  assert.equal((tail.items[tail.items.length - 1] as { text: string }).text, `msg ${extra - 1}`)

  // 翻更早页:before 取尾页最旧,同样不丢该页最新一条。
  const older = service.itemsWindow(sessionId, tail.oldestSequence, limit)
  assert.equal(older.hasMore, false)
  assert.equal(older.items.length, before + extra - limit)
  assert.equal((older.items[older.items.length - 1] as { text: string }).text, `msg ${extra - limit - 1}`)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for condition')
}
