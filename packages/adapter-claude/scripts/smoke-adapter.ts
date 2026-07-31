import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { asSessionId, asTurnId } from '@agent-gateway/core'
import { ClaudeAdapter } from '../src/claude-adapter.js'

const projectPath = await mkdtemp(resolve(tmpdir(), 'agent-gateway-claude-smoke-'))
const adapter = new ClaudeAdapter()
const sessionId = asSessionId(randomUUID())
const turnId = asTurnId(randomUUID())
let created = false

try {
  const connection = await adapter.connect({ context: { hostId: 'local' } })
  const handle = await adapter.createSession({ sessionId, projectPath, connection })
  created = true
  if (!handle.runtimeSessionId) throw new Error('Claude adapter did not return a runtime session id')

  const events = adapter.events(sessionId)
  await adapter.send(sessionId, { text: 'Reply with exactly: gateway adapter smoke' }, { turnId })

  const eventTypes: string[] = []
  const iterator = events[Symbol.asyncIterator]()
  const timeout = deferredTimeout(120_000)
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout.promise])
      if (next.done) throw new Error('Claude adapter event stream ended before turn completion')
      const event = next.value
      eventTypes.push(event.type)
      if (event.type === 'turn.failed') throw new Error(event.payload.error.message)
      if (event.type === 'turn.completed' && event.payload.turnId === turnId) break
    }
  } finally {
    timeout.cancel()
  }

  const required = ['session.created', 'turn.started', 'content.text.completed', 'turn.completed']
  for (const type of required) {
    if (!eventTypes.includes(type)) throw new Error(`Claude adapter smoke did not emit ${type}`)
  }
  process.stdout.write(`${JSON.stringify({ ok: true, eventTypes })}\n`)
} finally {
  if (created) await adapter.disposeSession(sessionId)
  await rm(projectPath, { recursive: true, force: true })
}

function deferredTimeout(milliseconds: number): {
  promise: Promise<never>
  cancel: () => void
} {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Claude adapter smoke timed out')), milliseconds)
  })
  return { promise, cancel: () => clearTimeout(timer) }
}
