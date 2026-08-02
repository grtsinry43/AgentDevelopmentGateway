import assert from 'node:assert/strict'
import test from 'node:test'
import { asSessionId, asTurnId } from '@agent-gateway/core'
import { toNativeMessageId } from '../src/input.js'
import { nativeSessionId } from './fixtures/opencode-v2.js'
import { createV2Harness, waitForRequest } from './support/v2-harness.js'

test('prefixes Gateway client message ids for OpenCode Message.ID', () => {
  assert.equal(
    toNativeMessageId('6689c1d1-aff3-417a-b941-b5d6460a7782'),
    'msg_6689c1d1-aff3-417a-b941-b5d6460a7782',
  )
  assert.equal(toNativeMessageId('msg_already_prefixed'), 'msg_already_prefixed')
})

test('lists the v2 model catalog and preserves ordered variants', async () => {
  const harness = await createV2Harness()
  try {
    const catalog = await harness.adapter.listModels({
      connection: harness.connection,
      projectPath: harness.directory,
    })
    assert.deepEqual(catalog, {
      models: [{
        id: 'openai/gpt-test',
        displayName: 'GPT Test',
        reasoningEfforts: [
          { id: 'low', displayName: 'low' },
          { id: 'high', displayName: 'high' },
        ],
      }],
    })
    const request = await waitForRequest(
      harness,
      (entry) => entry.method === 'GET' && entry.path === '/api/model',
    )
    assert.equal(
      request.search,
      `?location%5Bdirectory%5D=${encodeURIComponent(harness.directory)}`,
    )
  } finally {
    await harness.close()
  }
})

test('maps file attachments to legal PromptInput file URIs', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-attachment')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    await harness.adapter.send(
      sessionId,
      {
        clientMessageId: 'msg_attachment_contract',
        text: 'inspect',
        attachments: [{ kind: 'file', path: 'README.md' }],
        admitOnly: true,
      },
      { turnId: asTurnId('turn-attachment'), kind: 'start-turn' },
    )
    const request = await waitForRequest(
      harness,
      (entry) => entry.path === `/api/session/${nativeSessionId}/prompt`,
    )
    assert.deepEqual(request.body, {
      id: 'msg_attachment_contract',
      prompt: {
        text: 'inspect',
        files: [{
          uri: new URL('README.md', `file://${harness.directory}/`).href,
          name: 'README.md',
        }],
      },
      delivery: 'queue',
      resume: false,
    })
  } finally {
    await harness.close()
  }
})

test('rejects unproven inline attachment data', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-inline')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    await assert.rejects(
      harness.adapter.send(
        sessionId,
        {
          clientMessageId: 'msg_inline_contract',
          text: 'inspect',
          attachments: [{ kind: 'image', data: 'ZmFrZQ==' }],
          admitOnly: true,
        },
        { turnId: asTurnId('turn-inline'), kind: 'start-turn' },
      ),
      /does not prove inline attachment data is supported/,
    )
  } finally {
    await harness.close()
  }
})
