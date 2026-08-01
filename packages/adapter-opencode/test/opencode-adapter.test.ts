import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { asSessionId, asTurnId } from '@agent-gateway/core'
import { OpenCodeAdapter } from '../src/opencode-adapter.js'

test('maps connected models and sends the selected variant after resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-opencode-adapter-'))
  const executable = join(directory, 'fake-opencode')
  await writeFile(executable, fakeOpenCodeServer, 'utf8')
  await chmod(executable, 0o755)
  const adapter = new OpenCodeAdapter()

  try {
    const connection = await adapter.connect({
      context: { hostId: 'local', env: {} },
      installation: { path: executable, version: 'test', source: 'custom' },
    })
    const catalog = await adapter.listModels({ connection, projectPath: directory })
    assert.deepEqual(catalog, {
      models: [
        {
          id: 'openai/gpt-test',
          displayName: 'GPT Test',
          isDefault: true,
          reasoningEfforts: [
            { id: 'low', displayName: 'low' },
            { id: 'high', displayName: 'high' },
          ],
        },
      ],
    })

    const sessionId = asSessionId('resumed-session')
    await adapter.resumeSession({
      sessionId,
      projectPath: directory,
      runtimeSessionId: 'native-session',
      connection,
      model: { model: 'openai/gpt-test', reasoningEffort: 'high' },
    })
    await adapter.send(
      sessionId,
      { clientMessageId: 'message-1', text: 'hello' },
      { turnId: asTurnId('turn-1'), kind: 'start-turn' },
    )
  } finally {
    await adapter.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

const fakeOpenCodeServer = `#!/usr/bin/env node
const http = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/provider') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      all: [{
        id: 'openai',
        models: {
          'gpt-test': {
            id: 'gpt-test',
            name: 'GPT Test',
            variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }
          }
        }
      }],
      connected: ['openai'],
      default: { openai: 'gpt-test' }
    }))
    return
  }
  if (request.method === 'GET' && url.pathname === '/session/native-session') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: 'native-session' }))
    return
  }
  if (request.method === 'GET' && url.pathname === '/session/native-session/children') {
    response.setHeader('content-type', 'application/json')
    response.end('[]')
    return
  }
  if (request.method === 'GET' && url.pathname === '/event') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(': connected\\n\\n')
    return
  }
  if (request.method === 'POST' && url.pathname === '/session/native-session/prompt_async') {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const valid = parsed.model?.providerID === 'openai' &&
        parsed.model?.modelID === 'gpt-test' &&
        parsed.variant === 'high'
      response.statusCode = valid ? 204 : 400
      response.end(valid ? undefined : 'invalid model selection')
    })
    return
  }
  response.statusCode = 404
  response.end('not found')
})
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('opencode server listening on http://127.0.0.1:' + port + '\\n')
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
