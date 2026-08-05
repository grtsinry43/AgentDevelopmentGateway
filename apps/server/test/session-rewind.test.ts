import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { asSessionId, asToolCallId, asTurnId } from '@agent-gateway/core'
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

test('native rewind apply truncates durable events, items, and the runtime tail', async () => {
  const database = openGatewayDatabase(':memory:')
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const events = new SessionEventRepository(database)
  const items = new SessionItemRepository(database)
  const itemizer = new SessionItemizer(items, {
    listAfter: (sessionId, after) => events.listAfter(sessionId, after)
  })
  const adapter = new FakeRuntimeAdapter()
  adapter.descriptor.capabilities.rewind = 'native'
  let rewindMode: 'preview' | 'apply' | undefined
  adapter.rewindSession = async () => {
    rewindMode = 'apply'
    return {
      strategy: 'native',
      removedMessageCount: 0,
      fileDiff: [],
      available: { native: true, fork: false },
      filesReverted: true,
    }
  }
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
    const firstTurnId = adapter.sendCalls[0]?.options.turnId
    assert.ok(firstTurnId)

    // 第一个回合完成(user 消息 + assistant 文本 + 文件变更)
    await waitForSequence(service, sessionId, created.receipt.admittedSequence + 6)
    adapter.emit(asSessionId(sessionId), {
      type: 'content.text.completed',
      turnId: asTurnId(firstTurnId),
      payload: { blockId: 'block-first', text: 'Reply to: First turn' },
    })
    adapter.emit(asSessionId(sessionId), {
      type: 'changes.updated',
      turnId: asTurnId(firstTurnId),
      payload: {
        changeSet: {
          id: 'tool:first-edit',
          intent: 'applied',
          scope: 'tool',
          status: 'completed',
          toolCallId: asToolCallId('first-edit'),
          files: [
            {
              path: 'src/a.ts',
              pathKind: 'workspace-relative',
              kind: 'modify',
              additions: 1,
              deletions: 0,
              hunks: []
            }
          ]
        }
      }
    })
    // 第二个回合(user 消息 + 更多内容)—— 应被回退截断
    await service.send(sessionId, {
      input: { clientMessageId: randomUUID(), text: 'Second turn' }
    })
    const secondTurnId = adapter.sendCalls.at(-1)?.options.turnId
    assert.ok(secondTurnId)
    adapter.emit(asSessionId(sessionId), {
      type: 'content.text.completed',
      turnId: asTurnId(secondTurnId),
      payload: { blockId: 'block-second', text: 'Reply to: Second turn' },
    })
    await waitForSequence(service, sessionId, service.get(sessionId).lastEventSequence + 1)

    const before = service.get(sessionId)
    const firstInputSequence = created.receipt.admittedSequence
    assert.ok(before.lastEventSequence > firstInputSequence)

    // 回退到第一条用户消息:之后的事件/block 应全部消失。
    // 用户消息在 input.dispatched 才物化,目标用物化出的消息 item id(dispatched 序列)。
    const firstMessageItem = items
      .listBefore(sessionId, Number.MAX_SAFE_INTEGER, 1000)
      .find((item) => item.itemKind === 'message' && item.role === 'user' && item.text === 'First turn')
    assert.ok(firstMessageItem, 'first turn user message should be materialized')
    const result = await service.rewind(sessionId, {
      target: { by: 'message', messageUuid: firstMessageItem.id },
      mode: 'apply'
    })
    assert.equal(result.strategy, 'native')
    assert.equal(rewindMode, 'apply')

    const after = service.get(sessionId)
    // 选中消息本身也移除(回退到它发送之前):截断到 firstInputSequence - 1。
    assert.equal(after.lastEventSequence, firstInputSequence - 1)
    const durable = events.listAfter(sessionId, firstInputSequence - 1)
    assert.equal(durable.length, 0)
    const remainingItems = items.listBefore(sessionId, Number.MAX_SAFE_INTEGER, 1000)
    // 目标是第一条消息 → 截断后对话为空。
    assert.ok(
      remainingItems.every(
        (item) => !(item.itemKind === 'message' && item.role === 'user' && item.text === 'First turn')
      )
    )
    assert.ok(
      remainingItems.every(
        (item) => !(item.itemKind === 'message' && item.text === 'Reply to: Second turn')
      )
    )
    // 运行时实时流也截断了:没有 target 之后的事件。
    assert.equal(runtime.eventSnapshot(asSessionId(sessionId), firstInputSequence - 1).length, 0)
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('truncates the conversation even when the adapter file rewind throws', async () => {
  const database = openGatewayDatabase(':memory:')
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const events = new SessionEventRepository(database)
  const items = new SessionItemRepository(database)
  const itemizer = new SessionItemizer(items, {
    listAfter: (sessionId, after) => events.listAfter(sessionId, after)
  })
  const adapter = new FakeRuntimeAdapter()
  adapter.descriptor.capabilities.rewind = 'native'
  adapter.rewindSession = async () => {
    throw new Error('file checkpointing unavailable')
  }
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
    const firstTurnId = adapter.sendCalls[0]?.options.turnId
    assert.ok(firstTurnId)
    await waitForSequence(service, sessionId, created.receipt.admittedSequence + 6)
    adapter.emit(asSessionId(sessionId), {
      type: 'content.text.completed',
      turnId: asTurnId(firstTurnId),
      payload: { blockId: 'block-first', text: 'Reply to: First turn' },
    })
    await service.send(sessionId, {
      input: { clientMessageId: randomUUID(), text: 'Second turn' }
    })
    const secondTurnId = adapter.sendCalls.at(-1)?.options.turnId
    assert.ok(secondTurnId)
    adapter.emit(asSessionId(sessionId), {
      type: 'content.text.completed',
      turnId: asTurnId(secondTurnId),
      payload: { blockId: 'block-second', text: 'Reply to: Second turn' },
    })
    await waitForSequence(service, sessionId, service.get(sessionId).lastEventSequence + 1)

    const firstInputSequence = created.receipt.admittedSequence
    const firstMessageItem = items
      .listBefore(sessionId, Number.MAX_SAFE_INTEGER, 1000)
      .find((item) => item.itemKind === 'message' && item.role === 'user' && item.text === 'First turn')
    assert.ok(firstMessageItem, 'first turn user message should be materialized')
    // adapter 文件回退抛错 → apply 报错,但对话记录仍然被截断。
    await assert.rejects(
      service.rewind(sessionId, {
        target: { by: 'message', messageUuid: firstMessageItem.id },
        mode: 'apply'
      }),
      /checkpointing/
    )
    const after = service.get(sessionId)
    assert.equal(after.lastEventSequence, firstInputSequence - 1)
    assert.equal(events.listAfter(sessionId, firstInputSequence - 1).length, 0)
    const remainingItems = items.listBefore(sessionId, Number.MAX_SAFE_INTEGER, 1000)
    assert.ok(
      remainingItems.every(
        (item) => !(item.itemKind === 'message' && item.text === 'Reply to: Second turn')
      )
    )
    assert.ok(
      remainingItems.every(
        (item) => !(item.itemKind === 'message' && item.role === 'user' && item.text === 'First turn')
      )
    )
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = service.get(sessionId)
    if (session.lastEventSequence >= minimum) return session
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for sequence ${minimum}`)
}
