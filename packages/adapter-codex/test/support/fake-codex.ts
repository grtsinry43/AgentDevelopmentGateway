import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'

const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export async function createFakeCodex(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-contract-'))
  const executable = join(directory, 'fake-codex')
  await writeFile(executable, fakeCodexScript, 'utf8')
  await chmod(executable, 0o755)
  t.after(() => rm(directory, { recursive: true, force: true }))
  return executable
}

export function fakeCodexEnv(
  mode:
    | 'handshake'
    | 'rpc-id'
    | 'rpc-error'
    | 'notifications'
    | 'dynamic-tool'
    | 'adapter-contract',
  options: {
    fixture?: string
    fixtures?: string[]
    observationPath?: string
  } = {},
): Record<string, string> {
  return {
    FAKE_CODEX_MODE: mode,
    FAKE_CODEX_FIXTURES_DIRECTORY: fixturesDirectory,
    ...(options.fixture ? { FAKE_CODEX_FIXTURE: options.fixture } : {}),
    ...(options.fixtures ? { FAKE_CODEX_FIXTURES: options.fixtures.join(',') } : {}),
    ...(options.observationPath ? { FAKE_CODEX_OBSERVATION: options.observationPath } : {}),
  }
}

export async function readFixture<T = unknown>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixturesDirectory, name), 'utf8')) as T
}

export async function waitForJson<T = unknown>(path: string, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (error) {
      if (!isMissingFile(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for fake Codex observation at ${path}`)
}

export async function withTimeout<T>(
  promise: PromiseLike<T>,
  label: string,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

const fakeCodexScript = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')

const mode = process.env.FAKE_CODEX_MODE
const fixturesDirectory = process.env.FAKE_CODEX_FIXTURES_DIRECTORY
const observationPath = process.env.FAKE_CODEX_OBSERVATION
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(fixturesDirectory, name), 'utf8'))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const observe = (value) => {
  if (observationPath) writeFileSync(observationPath, JSON.stringify(value))
}
const observations = []
const appendObservation = (value) => {
  observations.push(value)
  observe(observations)
}

let dynamicTriggerId
let adapterTurnStartId
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'initialized') {
    if (mode === 'handshake') observe(message)
    return
  }
  if (mode === 'rpc-id' && message.method === 'test/echo') {
    send(loadFixture(process.env.FAKE_CODEX_FIXTURE))
    return
  }
  if (mode === 'rpc-error' && message.method === 'test/error') {
    send({
      id: message.id,
      error: {
        code: -32042,
        message: 'structured failure',
        data: { retryable: false, domain: 'contract' }
      }
    })
    return
  }
  if (message.method === 'thread/start') {
    if (mode === 'adapter-contract') appendObservation(message)
    send({ id: message.id, result: {
      thread: { id: 'native-thread' },
      model: 'gpt-test',
      reasoningEffort: 'medium'
    } })
    if (mode === 'notifications') {
      setTimeout(() => {
        for (const fixture of process.env.FAKE_CODEX_FIXTURES.split(',')) {
          send(loadFixture(fixture))
        }
      }, 20)
    }
    return
  }
  if (mode === 'adapter-contract' && message.method === 'thread/settings/update') {
    appendObservation(message)
    send({ id: message.id, result: {} })
    return
  }
  if (mode === 'adapter-contract' && message.method === 'turn/start') {
    appendObservation(message)
    adapterTurnStartId = message.id
    send({ id: 'host-dynamic-1', method: 'item/tool/call', params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      tool: 'lookup',
      namespace: 'gateway',
      arguments: { key: 'contract' }
    } })
    return
  }
  if (mode === 'adapter-contract' && message.method === undefined && message.id === 'host-dynamic-1') {
    appendObservation({ hostResponse: message })
    send({ id: 77, method: 'attestation/generate', params: {} })
    return
  }
  if (mode === 'adapter-contract' && message.method === undefined && message.id === 77) {
    appendObservation({ attestationResponse: message })
    send({ id: adapterTurnStartId, result: { turn: { id: 'native-turn' } } })
    return
  }
  if (mode === 'dynamic-tool' && message.method === 'test/emitDynamicTool') {
    dynamicTriggerId = message.id
    send(loadFixture(process.env.FAKE_CODEX_FIXTURE))
    return
  }
  if (mode === 'dynamic-tool' && message.method === undefined) {
    observe(message)
    send({ id: dynamicTriggerId, result: {} })
  }
})
`
