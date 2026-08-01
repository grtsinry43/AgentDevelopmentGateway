import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { asSessionId, asToolCallId, asTurnId } from '@agent-gateway/core'
import { AdapterRegistry, RuntimeSessionManager } from '@agent-gateway/runtime'
import { ProjectRepository } from '../src/features/projects/repository.js'
import { SessionEventRepository } from '../src/features/sessions/event-repository.js'
import { SessionRepository } from '../src/features/sessions/repository.js'
import { SessionService } from '../src/features/sessions/service.js'
import { openGatewayDatabase } from '../src/infrastructure/database.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('replays durable history before following a resumed runtime tail', async () => {
  const database = openGatewayDatabase(':memory:')
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const events = new SessionEventRepository(database)
  const adapter = new FakeRuntimeAdapter()
  const runtime = new RuntimeSessionManager(new AdapterRegistry([adapter]), events)
  const service = new SessionService(sessions, events, projects, runtime, {}, () => undefined)
  const projectId = randomUUID()
  const hostId = randomUUID()
  const now = Date.now()

  projects.create({
    id: projectId,
    hostId,
    path: '/test/project',
    normalizedPath: '/test/project',
    name: 'Test project',
    createdAt: now,
    updatedAt: now
  })

  try {
    const created = await service.create(projectId, {
      adapterId: 'claude-code',
      initialInput: { clientMessageId: randomUUID(), text: 'First turn' }
    })
    const sessionId = created.session.id
    const beforeClose = await waitForSequence(service, sessionId, created.receipt.admittedSequence + 6)
    const firstTurnId = adapter.sendCalls[0]?.options.turnId
    assert.ok(firstTurnId)
    adapter.emit(asSessionId(sessionId), {
      type: 'changes.updated',
      turnId: asTurnId(firstTurnId),
      payload: {
        changeSet: {
          id: 'tool:server-history-edit',
          intent: 'applied',
          scope: 'tool',
          status: 'completed',
          toolCallId: asToolCallId('server-history-edit'),
          files: [
            {
              path: 'src/history.ts',
              pathKind: 'workspace-relative',
              kind: 'modify',
              additions: 1,
              deletions: 0,
              hunks: []
            }
          ]
        }
      }
    })
    await waitForSequence(service, sessionId, beforeClose.lastEventSequence + 1)
    adapter.emit(asSessionId(sessionId), {
      type: 'task.updated',
      turnId: asTurnId(firstTurnId),
      payload: {
        update: {
          kind: 'replace',
          tasks: [
            { id: 'task-1', title: 'Persist task state', status: 'in_progress' },
            {
              id: 'task-2',
              title: 'Resume task state',
              status: 'pending',
              blockedBy: ['task-1']
            }
          ]
        }
      }
    })
    await waitForSequence(service, sessionId, beforeClose.lastEventSequence + 2)
    await service.close(sessionId, {})
    const closed = await waitForStatus(service, sessionId, 'closed')
    assert.ok(closed.lastEventSequence > beforeClose.lastEventSequence)
    assert.deepEqual(closed.taskState.tasks[1]?.blockedBy, ['task-1'])
    assert.deepEqual(await collectAll(service.events(sessionId, closed.lastEventSequence)), [])

    await service.resume(sessionId, {})
    const resumed = await waitForSequence(service, sessionId, closed.lastEventSequence + 2)
    const replayed = await collectThrough(service.events(sessionId), resumed.lastEventSequence)

    assert.equal(replayed[0]?.sequence, 1)
    assert.ok(
      replayed.some(
        (event) =>
          event.type === 'content.text.completed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'text' in event.payload &&
          event.payload.text === 'Reply to: First turn'
      )
    )
    assert.ok(replayed.some((event) => event.type === 'task.updated'))
    assert.equal(service.get(sessionId).taskState.tasks[0]?.title, 'Persist task state')
    assert.ok(
      replayed.some(
        (event) =>
          event.type === 'changes.updated' &&
          event.payload.changeSet.id === 'tool:server-history-edit'
      )
    )
    assert.equal(replayed.at(-1)?.sequence, resumed.lastEventSequence)
  } finally {
    await service.shutdown()
    database.close()
  }
})

async function waitForSequence(
  service: SessionService,
  sessionId: string,
  minimum: number
): Promise<ReturnType<SessionService['get']>> {
  return waitForSession(service, sessionId, (session) => session.lastEventSequence >= minimum)
}

async function waitForStatus(
  service: SessionService,
  sessionId: string,
  status: ReturnType<SessionService['get']>['status']
): Promise<ReturnType<SessionService['get']>> {
  return waitForSession(service, sessionId, (session) => session.status === status)
}

async function waitForSession(
  service: SessionService,
  sessionId: string,
  ready: (session: ReturnType<SessionService['get']>) => boolean
): Promise<ReturnType<SessionService['get']>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = service.get(sessionId)
    if (ready(session)) return session
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for Session ${sessionId}`)
}

async function collectThrough(
  source: AsyncIterable<import('@agent-gateway/core').RuntimeEvent>,
  targetSequence: number
): Promise<import('@agent-gateway/core').RuntimeEvent[]> {
  const collected: import('@agent-gateway/core').RuntimeEvent[] = []
  for await (const event of source) {
    collected.push(event)
    if (event.sequence >= targetSequence) break
  }
  return collected
}

async function collectAll(
  source: AsyncIterable<import('@agent-gateway/core').RuntimeEvent>
): Promise<import('@agent-gateway/core').RuntimeEvent[]> {
  const collected: import('@agent-gateway/core').RuntimeEvent[] = []
  for await (const event of source) collected.push(event)
  return collected
}
