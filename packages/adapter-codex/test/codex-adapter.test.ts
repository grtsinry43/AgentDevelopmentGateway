import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { asSessionId, asTurnId } from '@agent-gateway/core'
import { CodexAdapter } from '../src/codex-adapter.js'

test('keeps Gateway turn ids authoritative while addressing Codex by native turn id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-adapter-'))
  const executable = join(directory, 'fake-codex')
  await writeFile(executable, fakeAppServer, 'utf8')
  await chmod(executable, 0o755)

  const adapter = new CodexAdapter()
  try {
    const context = { hostId: 'local', env: { PATH: process.env.PATH ?? '' } }
    const connection = await adapter.connect({
      context,
      installation: { path: executable, version: 'test', source: 'custom' },
    })
    const sessionId = asSessionId('gateway-session')
    await adapter.createSession({ sessionId, projectPath: directory, connection })
    const events = adapter.events(sessionId)[Symbol.asyncIterator]()
    assert.equal((await events.next()).value?.type, 'session.created')
    assert.equal((await events.next()).value?.type, 'session.status_changed')

    const gatewayTurnId = asTurnId('gateway-turn')
    await adapter.send(
      sessionId,
      { clientMessageId: 'message-1', text: 'hello' },
      { turnId: gatewayTurnId, kind: 'start-turn' },
    )
    const started = (await events.next()).value
    assert.equal(started?.type, 'turn.started')
    if (started?.type === 'turn.started') assert.equal(started.payload.turnId, gatewayTurnId)

    await adapter.interrupt(sessionId)
  } finally {
    await adapter.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

const fakeAppServer = `#!/usr/bin/env node
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'thread/start') {
    send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'native-thread' } } })
  } else if (message.method === 'turn/start') {
    send({ jsonrpc: '2.0', method: 'turn/started', params: {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' }
    } })
    send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'native-turn' } } })
  } else if (message.method === 'turn/interrupt') {
    if (message.params.turnId !== 'native-turn') process.exit(2)
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
`
