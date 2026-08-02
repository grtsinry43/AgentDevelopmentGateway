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
      event('input.admitted', { entry: { input: { text: '你好' } } }),
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

  it('ignores out-of-order / duplicate events', () => {
    const state = createSessionItemState()
    const first: RuntimeEventWire = {
      id: 1,
      sequence: 1,
      sessionId: 'ses-1',
      adapterId: 'claude-code',
      timestamp: 1000,
      type: 'input.admitted',
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
})
