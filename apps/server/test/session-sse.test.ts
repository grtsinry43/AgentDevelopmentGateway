import assert from 'node:assert/strict'
import test from 'node:test'
import { asSessionId, type RuntimeEvent } from '@agent-gateway/core'
import { encodeSse } from '../src/features/sessions/routes.js'

test('emits heartbeat comments while a Session has no runtime events', async () => {
  const source = pendingEvents()
  const stream = encodeSse(source, 1)

  assert.equal((await stream.next()).value, ': heartbeat\n\n')
})

test('encodes runtime events without replacing them with heartbeat frames', async () => {
  const event: RuntimeEvent = {
    id: 1,
    sequence: 1,
    sessionId: asSessionId('session-1'),
    adapterId: 'claude-code',
    timestamp: 1,
    type: 'session.status_changed',
    payload: { status: 'running' }
  }
  const stream = encodeSse(replay([event]), 1_000)

  const frame = (await stream.next()).value
  assert.match(frame ?? '', /^id: 1\nevent: runtime\.event\ndata: /)
  assert.match(frame ?? '', /"type":"session.status_changed"/)
  assert.equal((await stream.next()).done, true)
})

async function* replay(events: RuntimeEvent[]): AsyncGenerator<RuntimeEvent> {
  yield* events
}

async function* pendingEvents(): AsyncGenerator<RuntimeEvent> {
  yield* [] as RuntimeEvent[]
  await new Promise(() => undefined)
}
