import assert from 'node:assert/strict'
import test from 'node:test'
import {
  asSessionId,
  asTurnId,
  type AdapterEvent,
  type RuntimeConnection,
} from '@agent-gateway/core'
import type { SDKMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeAdapter, type ClaudeQueryFactory } from '../src/claude-adapter.js'
import { loadFixture } from './fixture-loader.js'
import { FakeClaudeQuery } from './fakes/fake-query.js'

test('creates one initialized Query and reuses its input stream across turns', async () => {
  const fake = new FakeClaudeQuery()
  let captured: Parameters<ClaudeQueryFactory>[0] | undefined
  let factoryCalls = 0
  const adapter = new ClaudeAdapter((parameters) => {
    captured = parameters
    factoryCalls += 1
    return fake
  })
  const connection = await connect(adapter)
  const sessionId = asSessionId('gateway-session')
  let settled = false
  const creating = adapter
    .createSession({ sessionId, projectPath: '/workspace/project', connection })
    .then((handle) => {
      settled = true
      return handle
    })
  await Promise.resolve()
  assert.equal(settled, false)

  fake.resolveInitialization()
  const handle = await creating
  assert.equal(factoryCalls, 1)
  assert.equal(captured?.options?.cwd, '/workspace/project')
  assert.deepEqual(captured?.options?.settingSources, ['user', 'project', 'local'])
  assert.equal(captured?.options?.sessionId, handle.runtimeSessionId)

  const events = adapter.events(sessionId)[Symbol.asyncIterator]()
  assert.equal((await events.next()).value?.type, 'session.created')
  assert.equal((await events.next()).value?.type, 'session.status_changed')

  const sdkInput = captured!.prompt as AsyncIterable<SDKMessage>
  const inputIterator = sdkInput[Symbol.asyncIterator]()
  const firstTurn = asTurnId('turn-1')
  await adapter.send(sessionId, { text: 'first' }, { turnId: firstTurn })
  const firstInput = await inputIterator.next()
  assert.equal(firstInput.value?.type, 'user')
  assert.equal(firstInput.value?.message.content, 'first')
  assert.equal((await events.next()).value?.type, 'turn.started')
  assert.equal((await events.next()).value?.type, 'session.status_changed')

  fake.emit(await initMessage(handle.runtimeSessionId!))
  assert.equal((await nextEventOfType(events, 'session.capabilities_changed')).type, 'session.capabilities_changed')
  fake.emit(await resultMessage())
  await nextEventOfType(events, 'turn.completed')
  await nextEventOfType(events, 'session.status_changed')

  const secondTurn = asTurnId('turn-2')
  await adapter.send(sessionId, { text: 'second' }, { turnId: secondTurn })
  const secondInput = await inputIterator.next()
  assert.equal(secondInput.value?.message.content, 'second')
  assert.equal(factoryCalls, 1)

  await adapter.interrupt(sessionId)
  assert.equal(fake.interruptCount, 1)
  await adapter.setModel(sessionId, { model: 'claude-sonnet-4-6' })
  assert.deepEqual(fake.models, ['claude-sonnet-4-6'])
  await adapter.disposeSession(sessionId)
  assert.equal(fake.closed, true)
})

test('resumes with the runtime-owned project path and message cursor', async () => {
  const fake = new FakeClaudeQuery()
  let captured: Parameters<ClaudeQueryFactory>[0] | undefined
  const adapter = new ClaudeAdapter((parameters) => {
    captured = parameters
    return fake
  })
  const connection = await connect(adapter)
  const resuming = adapter.resumeSession({
    sessionId: asSessionId('resumed-gateway-session'),
    projectPath: '/remote/workspace/project',
    runtimeSessionId: 'provider-session',
    connection,
    cursor: { by: 'message', messageUuid: 'message-cut' },
  })
  fake.resolveInitialization()
  await resuming

  assert.equal(captured?.options?.cwd, '/remote/workspace/project')
  assert.equal(captured?.options?.resume, 'provider-session')
  assert.equal(captured?.options?.resumeSessionAt, 'message-cut')
  assert.equal(captured?.options?.sessionId, undefined)
})

test('cleans up a Query whose initialization fails', async () => {
  const fake = new FakeClaudeQuery()
  const adapter = new ClaudeAdapter(() => fake)
  const connection = await connect(adapter)
  const creating = adapter.createSession({
    sessionId: asSessionId('failed-session'),
    projectPath: '/workspace/project',
    connection,
  })
  fake.rejectInitialization(new Error('initialize failed'))

  await assert.rejects(creating, /initialize failed/)
  assert.equal(fake.closed, true)
  assert.throws(() => adapter.events(asSessionId('failed-session')), /Unknown Claude session/)
})

test('disposes a session cleanly after its Query pump fails', async () => {
  const fake = new FakeClaudeQuery()
  const adapter = new ClaudeAdapter(() => fake)
  const connection = await connect(adapter)
  const sessionId = asSessionId('pump-failed-session')
  const creating = adapter.createSession({ sessionId, projectPath: '/workspace/project', connection })
  fake.resolveInitialization()
  await creating

  const events = adapter.events(sessionId)[Symbol.asyncIterator]()
  await nextEventOfType(events, 'session.created')
  await nextEventOfType(events, 'session.status_changed')
  fake.fail(new Error('query pump failed'))
  await nextEventOfType(events, 'runtime.error')
  await nextEventOfType(events, 'session.status_changed')
  await assert.rejects(events.next(), /query pump failed/)

  await adapter.disposeSession(sessionId)
  assert.equal(fake.closed, true)
  assert.throws(() => adapter.events(sessionId), /Unknown Claude session/)
})

async function connect(adapter: ClaudeAdapter): Promise<RuntimeConnection> {
  return adapter.connect({ context: { hostId: 'local' } })
}

async function initMessage(runtimeSessionId: string): Promise<SDKSystemMessage> {
  const messages = await loadFixture('text-turn')
  const message = messages.find(
    (candidate): candidate is SDKSystemMessage => candidate.type === 'system' && candidate.subtype === 'init',
  )
  if (!message) throw new Error('Fixture has no Claude init message')
  return { ...message, session_id: runtimeSessionId }
}

async function resultMessage(): Promise<SDKMessage> {
  const messages = await loadFixture('text-turn')
  const message = messages.find((candidate) => candidate.type === 'result')
  if (!message) throw new Error('Fixture has no Claude result message')
  return message
}

async function nextEventOfType<T extends AdapterEvent['type']>(
  iterator: AsyncIterator<AdapterEvent>,
  type: T,
): Promise<Extract<AdapterEvent, { type: T }>> {
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new Error(`Event stream ended before ${type}`)
    if (next.value.type === type) return next.value as Extract<AdapterEvent, { type: T }>
  }
}
