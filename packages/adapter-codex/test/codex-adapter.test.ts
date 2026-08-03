import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { asSessionId, asTurnId } from '@agent-gateway/core'
import { CodexAdapter } from '../src/codex-adapter.js'

async function makeConnection() {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-adapter-'))
  const executable = join(directory, 'fake-codex')
  await writeFile(executable, fakeAppServer, 'utf8')
  await chmod(executable, 0o755)
  const adapter = new CodexAdapter()
  const context = { hostId: 'local', env: { PATH: process.env.PATH ?? '' } }
  const connection = await adapter.connect({
    context,
    installation: { path: executable, version: 'test', source: 'custom' },
  })
  return { adapter, connection, directory }
}

test('maps skills/list into unified slash commands with $ invoke', async () => {
  const { adapter, connection, directory } = await makeConnection()
  try {
    const commands = await adapter.listCommands({ connection, projectPath: directory })
    assert.equal(commands.length, 1)
    assert.deepEqual(commands[0], {
      name: 'code-review',
      description: 'Review',
      kind: 'skill',
      source: 'project',
      invoke: '$code-review',
    })
  } finally {
    await adapter.dispose?.()
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps Gateway turn ids authoritative while addressing Codex by native turn id', async () => {
  const { adapter, connection, directory } = await makeConnection()
  try {
    const catalog = await adapter.listModels({ connection, projectPath: directory })
    assert.deepEqual(catalog.models[0], {
      id: 'gpt-test',
      displayName: 'GPT Test',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      reasoningEfforts: [
        { id: 'low', displayName: 'low', description: 'Faster' },
        { id: 'medium', displayName: 'medium', description: 'Balanced' },
      ],
    })
    const sessionId = asSessionId('gateway-session')
    await adapter.createSession({
      sessionId,
      projectPath: directory,
      connection,
      model: { model: 'gpt-test', reasoningEffort: 'medium' },
    })
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
  } else if (message.method === 'model/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { data: [{
      id: 'gpt-test',
      model: 'gpt-test',
      displayName: 'GPT Test',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Faster' },
        { reasoningEffort: 'medium', description: 'Balanced' }
      ]
    }], nextCursor: null } })
  } else if (message.method === 'skills/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { data: [{
      cwd: message.params.cwds[0],
      skills: [
        { name: 'code-review', description: 'Review code', shortDescription: 'Review', path: '/x', scope: 'repo', enabled: true },
        { name: 'disabled-skill', description: 'Disabled', path: '/y', scope: 'user', enabled: false }
      ],
      errors: []
    }] } })
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
