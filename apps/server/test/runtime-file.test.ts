import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readRuntimeFile,
  removeRuntimeFile,
  writeRuntimeFile,
  type ServerRuntimeInfo
} from '../src/infrastructure/runtime-file.js'

function runtimeInfo(): ServerRuntimeInfo {
  return {
    pid: 1234,
    host: '127.0.0.1',
    port: 43_219,
    auth: 'token',
    token: 'test-token',
    hostId: randomUUID(),
    version: '0.0.0',
    protocolVersion: 6,
    startedAt: Date.now()
  }
}

test('writes and reads the runtime file with owner-only permissions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-runtime-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const path = join(directory, 'nested', 'runtime.json')

  const info = runtimeInfo()
  writeRuntimeFile(path, info)
  assert.deepEqual(readRuntimeFile(path), info)
  // 文件含连接 token,必须是 0600
  assert.equal((await stat(path)).mode & 0o777, 0o600)

  removeRuntimeFile(path)
  assert.equal(readRuntimeFile(path), undefined)
})

test('treats missing or corrupt runtime files as absent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-runtime-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const path = join(directory, 'runtime.json')

  assert.equal(readRuntimeFile(path), undefined)
  await writeFile(path, 'not json', 'utf8')
  assert.equal(readRuntimeFile(path), undefined)
  await writeFile(path, JSON.stringify({ pid: 'oops' }), 'utf8')
  assert.equal(readRuntimeFile(path), undefined)
})

test('rejects runtime info that fails schema validation', () => {
  assert.throws(() =>
    writeRuntimeFile(join(tmpdir(), 'never-written.json'), {
      ...runtimeInfo(),
      port: 0
    })
  )
})
