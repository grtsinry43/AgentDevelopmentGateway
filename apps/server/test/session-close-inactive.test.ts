import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AdapterRegistry, RuntimeSessionManager } from '@agent-gateway/runtime'
import { openGatewayDatabase } from '../src/infrastructure/database.js'
import { ProjectRepository } from '../src/features/projects/repository.js'
import { SessionRepository } from '../src/features/sessions/repository.js'
import { SessionEventRepository } from '../src/features/sessions/event-repository.js'
import { SessionItemRepository } from '../src/features/sessions/item-repository.js'
import { SessionItemizer } from '../src/features/sessions/session-itemizer.js'
import { MaterializedEventSink } from '../src/features/sessions/materialized-event-sink.js'
import { SessionService } from '../src/features/sessions/service.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('archives a non-active session without SESSION_NOT_ACTIVE', async () => {
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
      initialInput: { clientMessageId: randomUUID(), text: 'hello' }
    })
    const sessionId = created.session.id
    assert.equal(created.session.live, true)

    // 模拟重启:shutdown 释放所有会话,运行时不再持有。
    await service.shutdown()

    const stored = service.get(sessionId)
    assert.equal(stored.live, false)

    // 归档非活跃会话:不应报 SESSION_NOT_ACTIVE,直接标记 closed。
    await service.close(sessionId, {})
    const closed = service.get(sessionId)
    assert.equal(closed.status, 'closed')
    assert.equal(closed.live, false)

    // durable 事件里留了一条 closed 状态变更。
    const after = events.listAfter(sessionId, 0)
    assert.ok(after.some((event) => event.type === 'session.status_changed' && event.payload.status === 'closed'))
  } finally {
    await service.shutdown()
    database.close()
  }
})
