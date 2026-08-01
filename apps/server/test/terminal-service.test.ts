import assert from 'node:assert/strict'
import test from 'node:test'
import type { TerminalServerMessage } from '@agent-gateway/shared'
import type {
  TerminalPty,
  TerminalPtyDisposable,
  TerminalPtyExit,
  TerminalPtyFactory,
  TerminalPtySpawnOptions
} from '../src/features/terminals/pty.js'
import {
  TERMINAL_RETENTION_MS,
  TERMINAL_TAKEN_OVER_CLOSE_CODE,
  TerminalService,
  type TerminalAttachment,
  type TerminalScheduler
} from '../src/features/terminals/service.js'

test('restores a snapshot once and then resumes from an acknowledged sequence', async () => {
  const factory = new FakePtyFactory()
  const service = new TerminalService({
    projects: fakeProjects('/workspace/project'),
    environment: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    ptyFactory: factory,
    outputBufferBytes: 64
  })
  const descriptor = await service.create(PROJECT_ID, { cols: 80, rows: 24 })
  const pty = requirePty(factory)

  pty.emitData('first')
  const first = new FakeAttachment()
  await service.attach(descriptor.id, first, undefined, 80, 24)
  const snapshot = first.messages[0]
  assert.equal(snapshot?.type, 'terminal.snapshot')
  assert.equal(snapshot?.type === 'terminal.snapshot' && snapshot.sequence, 1)
  assert.match(snapshot?.type === 'terminal.snapshot' ? snapshot.data : '', /first/)

  pty.emitData(' second')
  await waitFor(() => first.outputs.length === 1)
  assert.deepEqual(first.outputs, [{ type: 'terminal.output', sequence: 2, data: ' second' }])
  service.acknowledge(descriptor.id, first, 2)
  service.detach(descriptor.id, first)

  pty.emitData(' third')
  const resumed = new FakeAttachment()
  await service.attach(descriptor.id, resumed, 2, 80, 24)
  assert.equal(resumed.messages[0]?.type, 'terminal.ready')
  assert.deepEqual(resumed.outputs, [{ type: 'terminal.output', sequence: 3, data: ' third' }])
})

test('falls back to a headless snapshot when the incremental sequence is no longer retained', async () => {
  const factory = new FakePtyFactory()
  const service = new TerminalService({
    projects: fakeProjects('/workspace/project'),
    environment: { SHELL: '/bin/zsh' },
    ptyFactory: factory,
    outputBufferBytes: 5
  })
  const descriptor = await service.create(PROJECT_ID, { cols: 80, rows: 24 })
  const pty = requirePty(factory)
  pty.emitData('first')
  pty.emitData('second')

  const attachment = new FakeAttachment()
  await service.attach(descriptor.id, attachment, 0, 80, 24)
  const snapshot = attachment.messages[0]
  assert.equal(snapshot?.type, 'terminal.snapshot')
  assert.equal(snapshot?.type === 'terminal.snapshot' && snapshot.sequence, 2)
  assert.match(snapshot?.type === 'terminal.snapshot' ? snapshot.data : '', /firstsecond/)
})

test('applies ACK flow control, exclusive takeover, input, resize and idle retention', async () => {
  const factory = new FakePtyFactory()
  const scheduler = new FakeScheduler()
  const service = new TerminalService({
    projects: fakeProjects('/workspace/project'),
    environment: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    ptyFactory: factory,
    scheduler,
    highWatermarkChars: 5,
    lowWatermarkChars: 2
  })
  const descriptor = await service.create(PROJECT_ID, { cols: 80, rows: 24 })
  const pty = requirePty(factory)
  assert.deepEqual(factory.spawns[0], {
    shell: '/bin/zsh',
    args: [],
    cwd: '/workspace/project',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    cols: 80,
    rows: 24,
    name: 'xterm-256color'
  })

  const first = new FakeAttachment()
  await service.attach(descriptor.id, first, undefined, 80, 24)
  service.write(descriptor.id, first, 'pwd\r')
  service.resize(descriptor.id, first, 120, 40)
  await waitFor(() => pty.resizes.length === 1)
  assert.deepEqual(pty.writes, ['pwd\r'])
  assert.deepEqual(pty.resizes, [[120, 40]])

  pty.emitData('12345')
  await waitFor(() => pty.pauseCount === 1)
  service.acknowledge(descriptor.id, first, 1)
  assert.equal(pty.resumeCount, 1)

  const second = new FakeAttachment()
  await service.attach(descriptor.id, second, 1, 120, 40)
  assert.deepEqual(first.closes, [
    { code: TERMINAL_TAKEN_OVER_CLOSE_CODE, reason: 'terminal_taken_over' }
  ])

  service.detach(descriptor.id, second)
  assert.equal(scheduler.delays.at(-1), TERMINAL_RETENTION_MS)
  scheduler.runAll()
  assert.equal(pty.killed, true)
  assert.deepEqual(service.list(PROJECT_ID), [])
})

test('retains an exited terminal long enough to restore its final state', async () => {
  const factory = new FakePtyFactory()
  const scheduler = new FakeScheduler()
  const service = new TerminalService({
    projects: fakeProjects('/workspace/project'),
    environment: { SHELL: '/bin/zsh' },
    ptyFactory: factory,
    scheduler
  })
  const descriptor = await service.create(PROJECT_ID, { cols: 80, rows: 24 })
  const pty = requirePty(factory)
  pty.emitData('complete\r\n')
  pty.emitExit({ exitCode: 7, signal: 0 })

  const attachment = new FakeAttachment()
  await service.attach(descriptor.id, attachment, undefined, 80, 24)
  assert.equal(attachment.messages[0]?.type, 'terminal.snapshot')
  assert.equal(attachment.messages.at(-1)?.type, 'terminal.exit')
  assert.deepEqual(attachment.closes, [{ code: 1000, reason: 'terminal_exited' }])
  assert.equal(service.list(PROJECT_ID)[0]?.status, 'exited')

  scheduler.runAll()
  assert.deepEqual(service.list(PROJECT_ID), [])
  assert.equal(pty.killed, false)
})

const PROJECT_ID = '4c756fb1-a495-4a63-91bd-9ebcb690faae'

function fakeProjects(path: string) {
  return {
    require(id: string): void {
      if (id !== PROJECT_ID) throw new Error('missing project')
    },
    async get(id: string) {
      this.require(id)
      return { path, availability: 'available' as const }
    }
  }
}

class FakePtyFactory implements TerminalPtyFactory {
  readonly spawns: TerminalPtySpawnOptions[] = []
  readonly ptys: FakePty[] = []

  spawn(options: TerminalPtySpawnOptions): TerminalPty {
    this.spawns.push(options)
    const pty = new FakePty()
    this.ptys.push(pty)
    return pty
  }
}

class FakePty implements TerminalPty {
  readonly pid = 42
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  killed = false
  pauseCount = 0
  resumeCount = 0
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: TerminalPtyExit) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  pause(): void {
    this.pauseCount += 1
  }

  resume(): void {
    this.resumeCount += 1
  }

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

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  emitExit(event: TerminalPtyExit): void {
    for (const listener of this.exitListeners) listener(event)
  }
}

class FakeAttachment implements TerminalAttachment {
  readonly messages: TerminalServerMessage[] = []
  readonly closes: Array<{ code: number; reason: string }> = []

  get outputs(): Array<Extract<TerminalServerMessage, { type: 'terminal.output' }>> {
    return this.messages.filter(
      (message): message is Extract<TerminalServerMessage, { type: 'terminal.output' }> =>
        message.type === 'terminal.output'
    )
  }

  send(message: TerminalServerMessage): void {
    this.messages.push(message)
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason })
  }
}

class FakeScheduler implements TerminalScheduler {
  readonly delays: number[] = []
  private readonly callbacks = new Map<number, () => void>()
  private nextId = 1

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.delays.push(delayMs)
    this.callbacks.set(id, callback)
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.callbacks.delete(handle)
  }

  runAll(): void {
    const pending = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of pending) callback()
  }
}

function requirePty(factory: FakePtyFactory): FakePty {
  const pty = factory.ptys[0]
  assert.ok(pty)
  return pty
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for terminal state')
}
