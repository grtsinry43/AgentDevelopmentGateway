import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  CodexRpcError,
  CodexAppServerClient,
  type RpcMessage,
  type ServerRequest,
} from '../src/app-server-client.js'
import {
  createFakeCodex,
  fakeCodexEnv,
  readFixture,
  waitForJson,
  withTimeout,
} from './support/fake-codex.js'

test('sends the generated initialized notification after initialize succeeds', async (t) => {
  const executable = await createFakeCodex(t)
  const observationPath = join(dirname(executable), 'initialized.json')
  const client = createClient(
    executable,
    fakeCodexEnv('handshake', { observationPath }),
  )

  try {
    await client.initialize('test')
    assert.deepEqual(
      await waitForJson(observationPath),
      await readFixture('client-initialized.json'),
    )
  } finally {
    await client.close()
  }
})

for (const fixture of ['rpc-response-number-id.json', 'rpc-response-string-id.json']) {
  test(`matches pending requests when a response uses ${fixture.includes('string') ? 'a string' : 'a number'} id`, async (t) => {
    const executable = await createFakeCodex(t)
    const client = createClient(executable, fakeCodexEnv('rpc-id', { fixture }))

    try {
      await client.initialize('test')
      const expected = await readFixture<{ result: unknown }>(fixture)
      assert.deepEqual(
        await withTimeout(client.request('test/echo'), `response from ${fixture}`),
        expected.result,
      )
    } finally {
      await client.close()
    }
  })
}

test('preserves structured RPC error code and data', async (t) => {
  const executable = await createFakeCodex(t)
  const client = createClient(executable, fakeCodexEnv('rpc-error'))
  try {
    await client.initialize('test')
    await assert.rejects(
      client.request('test/error'),
      (error: unknown) =>
        error instanceof CodexRpcError &&
        error.code === -32042 &&
        error.message === 'structured failure' &&
        JSON.stringify(error.data) ===
          JSON.stringify({ retryable: false, domain: 'contract' }),
    )
  } finally {
    await client.close()
  }
})

test('dispatches a generated dynamic tool server request and preserves its string id in the response', async (t) => {
  const executable = await createFakeCodex(t)
  const observationPath = join(dirname(executable), 'dynamic-tool-response.json')
  const expectedRequest = await readFixture('dynamic-tool-call-request.json')
  const expectedResponse = {
    contentItems: [{ type: 'inputText', text: 'CodexAdapter' }],
    success: true,
  }
  let receiveRequest: (request: ServerRequest) => void
  const receivedRequest = new Promise<ServerRequest>((resolve) => {
    receiveRequest = resolve
  })
  const client = new CodexAppServerClient(
    executable,
    fakeCodexEnv('dynamic-tool', {
      fixture: 'dynamic-tool-call-request.json',
      observationPath,
    }),
    () => undefined,
    (request) => {
      receiveRequest(request)
      return Promise.resolve(expectedResponse)
    },
    () => undefined,
  )

  await client.initialize('test')
  const trigger = client.request('test/emitDynamicTool')
  void trigger.catch(() => undefined)
  try {
    assert.deepEqual(
      await withTimeout(receivedRequest, 'dynamic tool request'),
      expectedRequest,
    )
    await withTimeout(trigger, 'dynamic tool response delivery')
    const response = await waitForJson<{
      id?: unknown
      result?: unknown
    }>(observationPath)
    assert.equal(response.id, 'dynamic-request-1')
    assert.deepEqual(response.result, expectedResponse)
  } finally {
    await client.close()
  }
})

function createClient(
  executable: string,
  env: Record<string, string>,
): CodexAppServerClient {
  return new CodexAppServerClient(
    executable,
    env,
    (_message: RpcMessage) => undefined,
    (_request: ServerRequest) => Promise.resolve({}),
    () => undefined,
  )
}
