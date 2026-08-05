import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { asSessionId, type RuntimeEvent, type SessionId } from '@agent-gateway/core'
import { SessionEventRepository } from '../src/features/sessions/event-repository.js'
import { SessionItemRepository } from '../src/features/sessions/item-repository.js'
import { MaterializedEventSink } from '../src/features/sessions/materialized-event-sink.js'
import { SessionItemizer } from '../src/features/sessions/session-itemizer.js'
import { openGatewayDatabase } from '../src/infrastructure/database.js'

let seq = 0
function event(
  sessionId: SessionId,
  type: string,
  payload: Record<string, unknown>,
  extras: Partial<RuntimeEvent> = {}
): RuntimeEvent {
  seq += 1
  return {
    id: seq,
    sequence: seq,
    sessionId,
    adapterId: 'claude-code',
    timestamp: Date.now() + seq,
    type,
    payload,
    ...extras,
  } as RuntimeEvent
}

function make(database: ReturnType<typeof openGatewayDatabase>) {
  const events = new SessionEventRepository(database)
  const items = new SessionItemRepository(database)
  const itemizer = new SessionItemizer(items, {
    listAfter: (sessionId, after) => events.listAfter(sessionId, after),
  })
  const sink = new MaterializedEventSink(events, itemizer)
  return { events, items, itemizer, sink }
}

test('materializes finalized conversation blocks into session_items', () => {
  const database = openGatewayDatabase(':memory:')
  const { items, sink } = make(database)
  const sessionId = asSessionId(randomUUID())
  sink.append(event(sessionId, 'input.dispatched', { entry: { input: { text: '你好' } } }))
  sink.append(event(sessionId, 'content.text.started', { blockId: 'b1' }))
  sink.append(event(sessionId, 'content.text.delta', { blockId: 'b1', delta: '你' }))
  sink.append(event(sessionId, 'content.text.completed', { blockId: 'b1', text: '你好！' }))
  sink.append(event(sessionId, 'tool.started', {
    toolCall: { id: 't1', name: 'Bash', kind: 'terminal', status: 'running' },
  }))
  sink.append(event(sessionId, 'tool.completed', {
    toolCall: { id: 't1', name: 'Bash', kind: 'terminal', status: 'completed', result: 'ok' },
  }))

  const head = items.headSequence(sessionId)
  // 块保留其起始 sequence:tool.started 是倒数第二条事件
  assert.equal(head, seq - 1)
  const page = items.listBefore(sessionId, Number.MAX_SAFE_INTEGER, 10)
  assert.equal(page.length, 3)
  assert.equal(page[0]?.itemKind, 'message')
  assert.equal((page[0] as { role: string; text: string }).role, 'user')
  assert.equal((page[0] as { text: string }).text, '你好')
  assert.equal((page[1] as { text: string }).text, '你好！')
  assert.equal(page[2]?.itemKind, 'tool')
  assert.equal((page[2] as { toolCall: { id: string } }).toolCall.id, 't1')
  database.close()
})

test('reconciles in-flight context across a simulated restart', () => {
  const database = openGatewayDatabase(':memory:')
  const { events, items, sink } = make(database)
  const sessionId = asSessionId(randomUUID())
  // 工具在"重启前"开始,text 在重启后完成
  sink.append(event(sessionId, 'tool.started', {
    toolCall: { id: 't1', name: 'Bash', kind: 'terminal', status: 'running' },
  }))
  const startedAt = events.maxSequence(sessionId)

  // 模拟重启:新的 itemizer(同一 DB)
  const restarted = new SessionItemizer(items, {
    listAfter: (sid, after) => events.listAfter(sid, after),
  })
  const restartSink = new MaterializedEventSink(events, restarted)
  restartSink.append(event(sessionId, 'tool.completed', {
    toolCall: { id: 't1', name: 'Bash', kind: 'terminal', status: 'completed', result: 'ok' },
  }))

  const page = items.listBefore(sessionId, Number.MAX_SAFE_INTEGER, 10)
  assert.equal(page.length, 1)
  const tool = page[0] as { toolCall: { status: string }; sequence: number }
  assert.equal(tool.toolCall.status, 'completed')
  // 重启后 reconcile 保留了工具的起始 sequence(而非用完成事件 seq)
  assert.equal(tool.sequence, startedAt)
  database.close()
})
