import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterEvent, RuntimeConnection } from '@agent-gateway/core'
import { OpenCodeAdapter } from '../../src/opencode-adapter.js'
import {
  admittedInput,
  existingSessionInfo,
  existingSessionTodos,
  globalEvents,
  modelCatalog,
  replayEvents,
  sessionDiffs,
  sessionInfo,
} from '../fixtures/opencode-v2.js'

export interface RecordedRequest {
  method: string
  path: string
  search: string
  body?: unknown
}

export interface V2Harness {
  adapter: OpenCodeAdapter
  connection: RuntimeConnection
  directory: string
  requests: () => Promise<RecordedRequest[]>
  close: () => Promise<void>
}

export interface V2HarnessOptions {
  /**
   * How the fake server signals turn completion after prompt. Default: sse-idle.
   * `admit-before-busy`: emit durable prompt.admitted while status map is empty,
   * then busy→idle — regressions must not settle in the admit window.
   */
  settleMode?: 'sse-idle' | 'status-poll' | 'admit-before-busy' | 'step-then-idle'
}

export async function createV2Harness(options: V2HarnessOptions = {}): Promise<V2Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-opencode-v2-'))
  const executable = join(directory, 'fake-opencode-v2')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(executable, fakeOpenCodeV2Server, 'utf8')
  await chmod(executable, 0o755)
  const adapter = new OpenCodeAdapter()
  const connection = await adapter.connect({
    context: {
      hostId: 'local',
      env: {
        OPENCODE_V2_FIXTURE: JSON.stringify({
          sessionInfo,
          existingSessionInfo,
          existingSessionTodos,
          admittedInput,
          globalEvents,
          modelCatalog,
          replayEvents,
          sessionDiffs,
          settleMode: options.settleMode ?? 'sse-idle',
        }),
        OPENCODE_V2_REQUEST_LOG: requestLog,
      },
    },
    installation: { path: executable, version: '1.18.10-fixture', source: 'custom' },
  })
  return {
    adapter,
    connection,
    directory,
    requests: async () => {
      try {
        const content = await readFile(requestLog, 'utf8')
        return content
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RecordedRequest)
      } catch (error) {
        if (isMissingFile(error)) return []
        throw error
      }
    },
    close: async () => {
      await adapter.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export async function waitForRequest(
  harness: V2Harness,
  predicate: (request: RecordedRequest) => boolean,
  timeoutMs = 1_000,
): Promise<RecordedRequest> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const request = (await harness.requests()).find(predicate)
    if (request) return request
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for request; saw ${JSON.stringify(await harness.requests())}`)
}

export async function collectUntil(
  events: AsyncIterable<AdapterEvent>,
  predicate: (events: AdapterEvent[]) => boolean,
  timeoutMs = 2_000,
): Promise<AdapterEvent[]> {
  const collected: AdapterEvent[] = []
  const iterator = events[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  while (!predicate(collected)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`Timed out collecting events: ${JSON.stringify(collected)}`)
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out collecting events: ${JSON.stringify(collected)}`)), remaining),
      ),
    ])
    if (result.done) break
    collected.push(result.value)
  }
  return collected
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const fakeOpenCodeV2Server = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const fixture = JSON.parse(process.env.OPENCODE_V2_FIXTURE)
const requestLog = process.env.OPENCODE_V2_REQUEST_LOG

const sendJson = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

let globalSse = null
let sessionSse = null
const sessionStatuses = Object.create(null)
const sessionTodos = Object.create(null)
sessionTodos[fixture.existingSessionInfo.id] = fixture.existingSessionTodos
sessionTodos[fixture.sessionInfo.id] = []
const wrapGlobal = (event) => ({
  directory: fixture.sessionInfo.location.directory,
  payload: {
    id: event.id,
    type: event.type,
    // Official bus uses \`properties\`; adapter also accepts \`data\`.
    properties: event.properties ?? event.data ?? {},
    ...(event.durable ? { durable: event.durable } : {}),
  },
})
const writeSse = (response, event) => {
  response.write('data: ' + JSON.stringify(event) + '\\n\\n')
}
const writeGlobal = (response, event) => writeSse(response, wrapGlobal(event))
const sendSse = (response, events, delay = 0) => {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  setTimeout(() => {
    for (const event of events) writeSse(response, event)
  }, delay)
}
const sendGlobalSse = (response, events, delay = 0) => {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  setTimeout(() => {
    for (const event of events) writeGlobal(response, event)
  }, delay)
}
const emitIdle = (sessionID) => {
  // CLI Wait: latch live via busy, then idle (armed && live && idle).
  sessionStatuses[sessionID] = { type: 'busy' }
  if (globalSse) {
    writeGlobal(globalSse, {
      id: 'evt_busy_' + Date.now(),
      type: 'session.status',
      properties: { sessionID, status: { type: 'busy' } },
    })
  }
  setTimeout(() => {
    delete sessionStatuses[sessionID]
    if (!globalSse) return
    writeGlobal(globalSse, {
      id: 'evt_idle_' + Date.now(),
      type: 'session.status',
      properties: { sessionID, status: { type: 'idle' } },
    })
  }, 50)
}
const settleViaStatusPoll = (sessionID) => {
  // Stay busy past the adapter's first 250ms poll so activity is observed before idle.
  sessionStatuses[sessionID] = { type: 'busy' }
  setTimeout(() => {
    delete sessionStatuses[sessionID]
  }, 400)
}
const settleViaAdmitBeforeBusy = (sessionID) => {
  // Reproduce the admit→busy gap: durable admit arrives while status map has no entry.
  const start = () => {
    if (!sessionSse) {
      setTimeout(start, 10)
      return
    }
    writeSse(sessionSse, {
      id: 'evt_admit_' + Date.now(),
      type: 'session.next.prompt.admitted',
      data: { sessionID, id: fixture.admittedInput.id },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
    })
    setTimeout(() => {
      sessionStatuses[sessionID] = { type: 'busy' }
      setTimeout(() => {
        delete sessionStatuses[sessionID]
      }, 400)
    }, 500)
  }
  start()
}
const settleViaStepThenIdle = (sessionID) => {
  // v2 often never populates /session/status; CLI settles on live activity + idle map.
  const start = () => {
    if (!sessionSse) {
      setTimeout(start, 10)
      return
    }
    writeSse(sessionSse, {
      id: 'evt_step_' + Date.now(),
      type: 'session.next.step.started',
      data: {
        sessionID,
        assistantMessageID: 'msg_assistant_step',
        agent: 'build',
        model: { id: 'gpt-test', providerID: 'openai' },
      },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
    })
    // Status map stays empty (= idle). Live latch from step.started should allow settle.
  }
  start()
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const record = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      ...(body ? { body: JSON.parse(body) } : {})
    }
    fs.appendFileSync(requestLog, JSON.stringify(record) + '\\n')

    // Official docs / SDK / CLI: GET /global/event (not /api/event)
    if (request.method === 'GET' && url.pathname === '/global/event') {
      globalSse = response
      sendGlobalSse(response, fixture.globalEvents, 50)
      return
    }
    if (request.method === 'GET' && url.pathname === '/session/status') {
      sendJson(response, sessionStatuses)
      return
    }
    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/session/') &&
      url.pathname.endsWith('/todo')
    ) {
      const sessionID = url.pathname.slice('/session/'.length, -('/todo'.length))
      sendJson(response, sessionTodos[sessionID] ?? [])
      return
    }
    // Official: GET /session/:id/diff?messageID=<user msg_> → SnapshotFileDiff[]
    // SessionSummary.diff returns [] unless messageID is a user message.
    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/session/') &&
      url.pathname.endsWith('/diff')
    ) {
      const messageID = url.searchParams.get('messageID') || ''
      if (!messageID.startsWith('msg')) {
        sendJson(response, [])
        return
      }
      sendJson(response, fixture.sessionDiffs ?? [])
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/model') {
      sendJson(response, {
        location: {
          directory: fixture.sessionInfo.location.directory,
          project: {
            id: fixture.sessionInfo.projectID,
            directory: fixture.sessionInfo.location.directory
          }
        },
        data: fixture.modelCatalog
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/session') {
      sendJson(response, { data: fixture.sessionInfo })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/session/' + fixture.existingSessionInfo.id) {
      sendJson(response, { data: fixture.existingSessionInfo })
      return
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/api/session/' + fixture.existingSessionInfo.id + '/event'
    ) {
      sendSse(response, [...fixture.replayEvents, fixture.replayEvents[0]], 100)
      return
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/api/session/' + fixture.sessionInfo.id + '/event'
    ) {
      sessionSse = response
      sendSse(response, [])
      return
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/session/' + fixture.sessionInfo.id + '/prompt'
    ) {
      sendJson(response, { data: fixture.admittedInput })
      // Live-only todo.updated on the global bus (matches OpenCode schema).
      sessionTodos[fixture.sessionInfo.id] = [
        { content: 'Live todo from prompt', status: 'in_progress', priority: 'high' },
      ]
      if (globalSse) {
        writeGlobal(globalSse, {
          id: 'evt_todo_live_' + Date.now(),
          type: 'todo.updated',
          properties: {
            sessionID: fixture.sessionInfo.id,
            todos: sessionTodos[fixture.sessionInfo.id],
          },
        })
      }
      if (fixture.settleMode === 'status-poll') {
        settleViaStatusPoll(fixture.sessionInfo.id)
      } else if (fixture.settleMode === 'admit-before-busy') {
        settleViaAdmitBeforeBusy(fixture.sessionInfo.id)
      } else if (fixture.settleMode === 'step-then-idle') {
        settleViaStepThenIdle(fixture.sessionInfo.id)
      } else {
        setTimeout(() => emitIdle(fixture.sessionInfo.id), 50)
      }
      return
    }
    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/api/session/') &&
      url.pathname.endsWith('/wait')
    ) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        _tag: 'ServiceUnavailableError',
        message: 'Session wait is not available yet',
        service: 'session.wait'
      }))
      return
    }
    // Official docs: POST /session/:id/abort
    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/session/') &&
      url.pathname.endsWith('/abort')
    ) {
      response.statusCode = 204
      response.end()
      return
    }
    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/api/session/') &&
      url.pathname.endsWith('/model')
    ) {
      response.statusCode = 204
      response.end()
      return
    }
    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/api/session/') &&
      (
        url.pathname.includes('/permission/') ||
        url.pathname.includes('/question/')
      )
    ) {
      response.statusCode = 204
      response.end()
      return
    }
    response.statusCode = 404
    response.end('v2 fixture exposes only /api/* routes')
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('opencode server listening on http://127.0.0.1:' + port + '\\n')
})
process.on('SIGTERM', () => process.exit(0))
`
