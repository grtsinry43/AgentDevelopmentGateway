import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionItemEvent,
  createSessionItemState,
  sessionTimeline,
  type SessionItemState,
} from '../src/session-items.js'
import type { RuntimeEventWire } from '../src/server-contract.js'

let seq = 0
function event(type: string, payload: Record<string, unknown>, extras: Partial<RuntimeEventWire> = {}): RuntimeEventWire {
  seq += 1
  return {
    id: seq,
    sequence: seq,
    sessionId: 'ses-1',
    adapterId: 'claude-code',
    timestamp: Date.now() + seq,
    type,
    payload,
    ...extras,
  }
}

function feed(state: SessionItemState, ...events: RuntimeEventWire[]): SessionItemState {
  for (const e of events) applySessionItemEvent(state, e)
  return state
}

describe('session itemizer', () => {
  it('concatenates a user message and assistant text with deltas into blocks', () => {
    const state = feed(
      createSessionItemState(),
      event('input.dispatched', { entry: { input: { text: '你好' } } }),
      event('content.text.started', { blockId: 'b1' }),
      event('content.text.delta', { blockId: 'b1', delta: '你' }),
      event('content.text.delta', { blockId: 'b1', delta: '好' }),
      event('content.text.completed', { blockId: 'b1', text: '你好！' }),
    )
    const timeline = sessionTimeline(state)
    assert.equal(timeline.length, 2)
    assert.equal(timeline[0]?.itemKind, 'message')
    assert.equal((timeline[0] as { role: string }).role, 'user')
    assert.equal((timeline[1] as { text: string }).text, '你好！')
    assert.equal((timeline[1] as { streaming: boolean }).streaming, false)
  })

  it('finalizes a tool call block on tool.completed', () => {
    const state = feed(
      createSessionItemState(),
      event('tool.started', {
        toolCall: { id: 't1', name: 'Bash', kind: 'terminal', status: 'running' },
      }),
      event('tool.output_delta', { toolCallId: 't1', delta: 'out1' }),
      event('tool.completed', {
        toolCall: { id: 't1', name: 'Bash', kind: 'terminal', status: 'completed', result: 'ok' },
      }),
    )
    const timeline = sessionTimeline(state)
    assert.equal(timeline.length, 1)
    assert.equal(timeline[0]?.itemKind, 'tool')
    const tool = timeline[0] as { toolCall: { id: string; status: string }; outputDelta?: string }
    assert.equal(tool.toolCall.id, 't1')
    assert.equal(tool.toolCall.status, 'completed')
    assert.equal(tool.outputDelta, 'out1')
  })

  it('keeps reasoning as a separate contentKind block', () => {
    const state = feed(
      createSessionItemState(),
      event('content.reasoning.started', { blockId: 'r1' }),
      event('content.reasoning.delta', { blockId: 'r1', delta: '想' }),
      event('content.reasoning.completed', { blockId: 'r1', text: '想清楚' }),
      event('content.text.started', { blockId: 'b1' }),
      event('content.text.completed', { blockId: 'b1', text: '结论' }),
    )
    const timeline = sessionTimeline(state)
    assert.equal(timeline.length, 2)
    assert.equal((timeline[0] as { contentKind: string }).contentKind, 'reasoning')
    assert.equal((timeline[1] as { contentKind: string }).contentKind, 'text')
  })

  it('finalizes subagent on subagent.completed', () => {
    const state = feed(
      createSessionItemState(),
      event('subagent.started', { run: { id: 's1', status: 'running' } }),
      event('subagent.completed', { run: { id: 's1', status: 'completed' } }),
    )
    const timeline = sessionTimeline(state)
    assert.equal(timeline.length, 1)
    assert.equal(timeline[0]?.itemKind, 'subagent')
    assert.equal((timeline[0] as { run: { status: string } }).run.status, 'completed')
  })

  it('keeps a subagent in place when its status updates (no drift to the bottom)', () => {
    const state = feed(
      createSessionItemState(),
      event('input.dispatched', { entry: { input: { text: 'before' } } }),
      event('subagent.started', { run: { id: 's1', status: 'running' } }),
      event('subagent.updated', { run: { id: 's1', status: 'running', updated: 'once' } }),
      event('subagent.updated', { run: { id: 's1', status: 'running', updated: 'twice' } }),
      event('subagent.completed', { run: { id: 's1', status: 'completed' } }),
      event('input.dispatched', { entry: { input: { text: 'after' } } }),
    )
    const timeline = sessionTimeline(state)
    assert.equal(timeline.length, 3)
    assert.equal((timeline[0] as { role: string }).role, 'user')
    assert.equal((timeline[0] as { text: string }).text, 'before')
    // 无论多少次 updated,subagent 都钉在第一个 user 消息之后、第二个之前。
    assert.equal(timeline[1]?.itemKind, 'subagent')
    assert.equal((timeline[1] as { run: { id: string; status: string } }).run.id, 's1')
    assert.equal((timeline[1] as { run: { id: string; status: string } }).run.status, 'completed')
    assert.equal((timeline[2] as { text: string }).text, 'after')
    // 原始 sequence 保住了(在 before 与 after 之间),而不是漂到最新。
    const subagent = timeline[1] as { sequence: number }
    const before = timeline[0] as { sequence: number }
    const after = timeline[2] as { sequence: number }
    assert.ok(subagent.sequence > before.sequence && subagent.sequence < after.sequence)
  })

  it('survives re-materialization: replayed subagent events re-finalize the same item', () => {
    const events = [
      event('input.dispatched', { entry: { input: { text: 'before' } } }),
      event('subagent.started', { run: { id: 's1', status: 'running' } }),
      event('subagent.updated', { run: { id: 's1', status: 'running', updated: 'once' } }),
      event('subagent.completed', { run: { id: 's1', status: 'completed' } }),
      event('input.dispatched', { entry: { input: { text: 'after' } } }),
    ]
    const first = feed(createSessionItemState(), ...events)
    // 模拟重放:全新 state 从同一批 durable 事件重建(会话切换后回来)。
    const rebuilt = feed(createSessionItemState(), ...events)
    for (const [label, state] of [
      ['first', first],
      ['rebuilt', rebuilt],
    ] as const) {
      const timeline = sessionTimeline(state)
      assert.equal(timeline.length, 3, `${label}: expected 3 blocks`)
      assert.equal(timeline[1]?.itemKind, 'subagent', `${label}: subagent missing`)
      const subagent = timeline[1] as { run: { id: string; status: string }; sequence: number }
      assert.equal(subagent.run.id, 's1')
      assert.equal(subagent.run.status, 'completed')
      const before = timeline[0] as { sequence: number }
      const after = timeline[2] as { sequence: number }
      assert.ok(subagent.sequence > before.sequence && subagent.sequence < after.sequence)
    }
  })

  it('tracks a tool-scoped change set onto its tool', () => {
    const state = feed(
      createSessionItemState(),
      event('tool.started', { toolCall: { id: 't1', name: 'Edit', kind: 'file-edit', status: 'running' } }),
      event('changes.updated', {
        changeSet: { id: 'c1', scope: 'tool', toolCallId: 't1', files: [] },
      }),
      event('tool.completed', {
        toolCall: { id: 't1', name: 'Edit', kind: 'file-edit', status: 'completed' },
      }),
    )
    const timeline = sessionTimeline(state)
    assert.equal(timeline.length, 1)
    const tool = timeline[0] as { changeSet?: { id: string } }
    assert.equal(tool.changeSet?.id, 'c1')
  })

  it('attaches a change set that arrives after tool.completed', () => {    const state = feed(
      createSessionItemState(),
      event('tool.started', { toolCall: { id: 't1', name: 'Edit', kind: 'file-edit', status: 'running' } }),
      event('tool.completed', {
        toolCall: { id: 't1', name: 'Edit', kind: 'file-edit', status: 'completed' },
      }),
      // diff 汇总晚到(Claude 的常见顺序):tool 已定型也要补挂,且不产生重复块。
      event('changes.updated', {
        changeSet: {
          id: 'c1',
          scope: 'tool',
          toolCallId: 't1',
          files: [{ path: 'a.ts', hunks: [] }],
        },
      }),
    )
    const timeline = sessionTimeline(state)
    assert.equal(timeline.length, 1)
    const tool = timeline[0] as { changeSet?: { id: string; files: unknown[] } }
    assert.equal(tool.changeSet?.id, 'c1')
    assert.equal(tool.changeSet?.files.length, 1)
  })

  it('ignores out-of-order / duplicate events', () => {    const state = createSessionItemState()
    const first: RuntimeEventWire = {
      id: 1,
      sequence: 1,
      sessionId: 'ses-1',
      adapterId: 'claude-code',
      timestamp: 1000,
      type: 'input.dispatched',
      payload: { entry: { input: { text: 'a' } } },
    }
    const dup: RuntimeEventWire = { ...first, id: 2 }
    const stale: RuntimeEventWire = { ...first, id: 3, sequence: 0 }
    applySessionItemEvent(state, first)
    applySessionItemEvent(state, dup) // 同 sequence 重复 → 忽略
    applySessionItemEvent(state, stale) // 乱序 → 忽略
    assert.equal(state.lastSequence, 1)
    assert.equal(state.items.length, 1)
  })

  it('keeps a subagent-attributed tool call out of the main timeline', () => {
    const subagentRunId = 'run-1'
    const state = feed(
      createSessionItemState(),
      event(
        'tool.started',
        { toolCall: { id: 't1', name: 'Read', kind: 'file-read', status: 'running' } },
        { attribution: { subagentRunId, sourceKind: 'subagent', depth: 1 } }
      ),
      event(
        'tool.completed',
        { toolCall: { id: 't1', name: 'Read', kind: 'file-read', status: 'completed' } },
        { attribution: { subagentRunId, sourceKind: 'subagent', depth: 1 } }
      )
    )
    const tool = state.items[0] as { itemKind: string; subagentRunId?: string }
    assert.equal(tool.itemKind, 'tool')
    assert.equal(tool.subagentRunId, subagentRunId)
  })
})
