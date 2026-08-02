import assert from 'node:assert/strict'
import test from 'node:test'
import { AdapterError, asSessionId } from '@agent-gateway/core'
import { handleHostServerRequest } from '../src/runtime/host-server-request.js'

test('answers Codex currentTime/read with whole unix seconds', async () => {
  const before = Math.floor(Date.now() / 1_000)
  const response = await handleHostServerRequest({
    id: 'codex:10',
    sessionId: asSessionId('session-1'),
    method: 'codex.currentTime.read',
    params: { threadId: 'thread-123' },
  })
  const after = Math.floor(Date.now() / 1_000)
  assert.equal(response.id, 'codex:10')
  assert.ok(typeof response.result === 'object' && response.result !== null)
  const currentTimeAt = (response.result as { currentTimeAt?: unknown }).currentTimeAt
  assert.ok(typeof currentTimeAt === 'number')
  assert.ok(currentTimeAt >= before && currentTimeAt <= after)
})

test('rejects unsupported host server requests with a structured error', async () => {
  await assert.rejects(
    handleHostServerRequest({
      id: 'codex:host-dynamic-1',
      sessionId: asSessionId('session-1'),
      method: 'codex.dynamicTool.call',
      params: { tool: 'lookup' },
    }),
    (error: unknown) =>
      error instanceof AdapterError &&
      error.runtimeError.code === 'not_implemented' &&
      error.runtimeError.nativeCode === 'gateway.server_request.unsupported',
  )
})
