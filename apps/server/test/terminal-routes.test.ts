import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  TerminalPty,
  TerminalPtyDisposable,
  TerminalPtyExit,
  TerminalPtyFactory
} from '../src/features/terminals/pty.js'
import { buildServer } from '../src/app.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('exposes validated terminal HTTP controls and WebSocket input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-terminal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projectPath = join(directory, 'project')
  await mkdir(projectPath)
  const factory = new RoutePtyFactory()
  const server = buildServer({
    adapters: [new FakeRuntimeAdapter()],
    databasePath: join(directory, 'gateway.sqlite'),
    terminalPtyFactory: factory,
    logger: false
  })
  t.after(() => server.close())
  await server.ready()

  const projectResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: projectPath }
  })
  const projectId = projectResponse.json<{ id: string }>().id
  const invalid = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/terminals`,
    payload: { cols: 1, rows: 24 }
  })
  assert.equal(invalid.statusCode, 400)

  const created = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/terminals`,
    payload: { cols: 90, rows: 30 }
  })
  assert.equal(created.statusCode, 201)
  const terminalId = created.json<{ id: string }>().id
  assert.equal(factory.pty !== undefined, true)

  const socket = await server.injectWS(`/api/v1/terminals/${terminalId}/attach`)
  t.after(() => socket.terminate())
  const messages: unknown[] = []
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
  socket.send(JSON.stringify({ type: 'terminal.attach', cols: 90, rows: 30 }))
  await waitFor(() => messages.length === 1)
  assert.equal((messages[0] as { type?: string }).type, 'terminal.snapshot')
  socket.send(JSON.stringify({ type: 'terminal.input', data: 'echo ready\r' }))
  socket.send(JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 36 }))
  await waitFor(() => factory.pty?.writes.length === 1 && factory.pty.resizes.length === 1)
  assert.deepEqual(factory.pty?.writes, ['echo ready\r'])
  assert.deepEqual(factory.pty?.resizes, [[100, 36]])

  const listed = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/terminals`
  })
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json<{ terminals: unknown[] }>().terminals.length, 1)

  const closed = await server.inject({ method: 'DELETE', url: `/api/v1/terminals/${terminalId}` })
  assert.equal(closed.statusCode, 204)
  assert.equal(factory.pty?.killed, true)
})

class RoutePtyFactory implements TerminalPtyFactory {
  pty?: RoutePty

  spawn(): TerminalPty {
    this.pty = new RoutePty()
    return this.pty
  }
}

class RoutePty implements TerminalPty {
  readonly pid = 7
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  killed = false
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: TerminalPtyExit) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  pause(): void {}

  resume(): void {}

  kill(): void {
    this.killed = true
  }

  onData(listener: (data: string) => void): TerminalPtyDisposable {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for terminal input')
}
