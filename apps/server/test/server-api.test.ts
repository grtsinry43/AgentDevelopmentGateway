import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { asInteractionId, asSessionId, asToolCallId } from '@agent-gateway/core'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { buildServer } from '../src/app.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('serves the project and session lifecycle through validated HTTP contracts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-api-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const projectDirectory = join(directory, 'project')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(projectDirectory))
  const databasePath = join(directory, 'gateway.sqlite')
  const adapter = new FakeRuntimeAdapter()
  const first = buildServer({ adapters: [adapter], databasePath, logger: false })
  first.withTypeProvider<ZodTypeProvider>().get(
    '/test-response-leak',
    {
      schema: {
        response: { 200: z.strictObject({ safe: z.string() }) }
      }
    },
    async () => ({ safe: 'visible', secret: 'hidden' })
  )
  t.after(() => first.close())

  const serverInfo = await first.inject({ method: 'GET', url: '/api/v1/server' })
  assert.equal(serverInfo.statusCode, 200)
  const serverId = serverInfo.json<{ serverId: string }>().serverId

  const invalid = await first.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: projectDirectory, unexpected: true }
  })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json<{ error: { code: string } }>().error.code, 'VALIDATION_ERROR')

  const createdProject = await first.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: projectDirectory, name: 'Gateway' }
  })
  assert.equal(createdProject.statusCode, 201)
  const project = createdProject.json<{ id: string; hostId: string; availability: string }>()
  assert.equal(project.hostId, serverId)
  assert.equal(project.availability, 'available')

  const duplicate = await first.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: `${projectDirectory}/` }
  })
  assert.equal(duplicate.statusCode, 409)
  assert.equal(duplicate.json<{ error: { code: string } }>().error.code, 'PROJECT_CONFLICT')

  const agents = await first.inject({
    method: 'GET',
    url: `/api/v1/projects/${project.id}/agents`
  })
  assert.equal(agents.statusCode, 200)
  assert.deepEqual(
    agents.json<{ adapters: Array<{ adapterId: string }> }>().adapters.map((item) => item.adapterId),
    ['claude-code']
  )

  const createdSession = await first.inject({
    method: 'POST',
    url: `/api/v1/projects/${project.id}/sessions`,
    payload: {
      adapterId: 'claude-code',
      initialInput: {
        clientMessageId: '28d560a7-4fe7-49f3-b6c2-d5e5376262f9',
        text: 'Inspect this project'
      }
    }
  })
  assert.equal(createdSession.statusCode, 201)
  const createdSessionBody = createdSession.json<{
    session: { id: string; adapterId: string; title?: string }
    receipt: { turnId: string; admittedSequence: number }
  }>()
  const session = createdSessionBody.session
  assert.equal(session.adapterId, 'claude-code')
  assert.equal(session.title, 'Inspect this project')
  assert.ok(createdSessionBody.receipt.admittedSequence > 0)

  const continued = await first.inject({
    method: 'POST',
    url: `/api/v1/sessions/${session.id}/inputs`,
    payload: {
      input: {
        clientMessageId: 'f59e9b9d-7590-4ed1-a8b2-51e939714e8f',
        text: 'Continue the inspection'
      }
    }
  })
  assert.equal(continued.statusCode, 202)

  const blockedDelete = await first.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${project.id}`
  })
  assert.equal(blockedDelete.statusCode, 409)
  assert.equal(
    blockedDelete.json<{ error: { code: string } }>().error.code,
    'PROJECT_HAS_ACTIVE_SESSIONS'
  )

  const changedMode = await first.inject({
    method: 'PATCH',
    url: `/api/v1/sessions/${session.id}/work-mode`,
    payload: { workMode: 'plan', expectedRevision: 0 }
  })
  assert.equal(changedMode.statusCode, 200)
  assert.equal(changedMode.json<{ controlRevision: number }>().controlRevision, 1)

  const staleMode = await first.inject({
    method: 'PATCH',
    url: `/api/v1/sessions/${session.id}/work-mode`,
    payload: { workMode: 'build', expectedRevision: 0 }
  })
  assert.equal(staleMode.statusCode, 409)
  assert.equal(
    staleMode.json<{ error: { code: string } }>().error.code,
    'SESSION_REVISION_CONFLICT'
  )

  const renamed = await first.inject({
    method: 'PATCH',
    url: `/api/v1/sessions/${session.id}/title`,
    payload: { title: 'Controlled session', expectedRevision: 1 }
  })
  assert.equal(renamed.statusCode, 200)
  assert.equal(renamed.json<{ controlRevision: number }>().controlRevision, 2)

  const changedModel = await first.inject({
    method: 'PATCH',
    url: `/api/v1/sessions/${session.id}/model`,
    payload: { model: 'test-model', expectedRevision: 2 }
  })
  assert.equal(changedModel.statusCode, 200)
  assert.equal(changedModel.json<{ controlRevision: number }>().controlRevision, 3)

  const interrupted = await first.inject({
    method: 'POST',
    url: `/api/v1/sessions/${session.id}/interrupt`,
    payload: {}
  })
  assert.equal(interrupted.statusCode, 204)
  assert.equal(adapter.interruptCount, 1)

  const interactionId = asInteractionId('5d88a940-84b7-4800-aa6f-a2139900e05a')
  adapter.emit(asSessionId(session.id), {
    type: 'interaction.permission_requested',
    payload: {
      request: {
        id: interactionId,
        kind: 'tool_permission',
        sessionId: asSessionId(session.id),
        toolCallId: asToolCallId('tool-call'),
        createdAt: Date.now(),
        toolKind: 'terminal',
        toolName: 'Bash',
        input: { command: 'pwd' },
        prompt: 'Allow test tool?',
        availableDecisions: ['allow', 'deny']
      }
    }
  })
  await waitFor(async () => {
    const response = await first.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}` })
    const pending = response.json<{
      pendingInteractions: Array<{ toolName?: string; input?: unknown }>
    }>().pendingInteractions
    return (
      pending.length === 1 &&
      pending[0]?.toolName === 'Bash' &&
      JSON.stringify(pending[0]?.input) === JSON.stringify({ command: 'pwd' })
    )
  })

  const resolvedInteraction = await first.inject({
    method: 'POST',
    url: `/api/v1/sessions/${session.id}/interactions/${interactionId}/resolve`,
    payload: {
      resolution: {
        kind: 'tool_permission',
        id: interactionId,
        decision: { behavior: 'allow' }
      }
    }
  })
  assert.equal(resolvedInteraction.statusCode, 204)
  assert.equal(adapter.resolutions.length, 1)

  const closed = await first.inject({
    method: 'POST',
    url: `/api/v1/sessions/${session.id}/close`,
    payload: { expectedRevision: 3 }
  })
  assert.equal(closed.statusCode, 200)
  assert.equal(closed.json<{ controlRevision: number }>().controlRevision, 4)

  const resumed = await first.inject({
    method: 'POST',
    url: `/api/v1/sessions/${session.id}/resume`,
    payload: {}
  })
  assert.equal(resumed.statusCode, 200)
  assert.equal(resumed.json<{ controlRevision: number }>().controlRevision, 4)

  const forked = await first.inject({
    method: 'POST',
    url: `/api/v1/sessions/${session.id}/forks`,
    payload: {}
  })
  assert.equal(forked.statusCode, 201)
  assert.notEqual(forked.json<{ id: string }>().id, session.id)

  const leaked = await first.inject({ method: 'GET', url: '/test-response-leak' })
  assert.equal(leaked.statusCode, 500)
  assert.doesNotMatch(leaked.body, /hidden/)

  await first.close()

  const second = buildServer({ adapters: [new FakeRuntimeAdapter()], databasePath, logger: false })
  t.after(() => second.close())
  const reopenedInfo = await second.inject({ method: 'GET', url: '/api/v1/server' })
  assert.equal(reopenedInfo.json<{ serverId: string }>().serverId, serverId)
  const recovered = await second.inject({
    method: 'GET',
    url: `/api/v1/sessions/${session.id}`
  })
  assert.equal(recovered.statusCode, 200)
  assert.equal(recovered.json<{ status: string }>().status, 'interrupted')

  const replay = await second.inject({
    method: 'GET',
    url: `/api/v1/sessions/${session.id}/events?after=0`
  })
  assert.equal(replay.statusCode, 200)
  assert.match(replay.headers['content-type'] ?? '', /^text\/event-stream/)
  const replayEvents = replay.body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; payload: unknown })
  assert.ok(replayEvents.some((event) => event.type === 'input.admitted'))
  assert.ok(replayEvents.some((event) => event.type === 'content.text.completed'))
  assert.ok(!replayEvents.some((event) => event.type === 'content.text.delta'))

  const removed = await second.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${project.id}`
  })
  assert.equal(removed.statusCode, 204)

  const restored = await second.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: projectDirectory, name: 'Gateway restored' }
  })
  assert.equal(restored.statusCode, 201)
  assert.equal(restored.json<{ id: string }>().id, project.id)
})

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for condition')
}

test('requires an installation choice when an adapter has multiple installations', async (t) => {
  const server = buildServer({
    adapters: [
      new FakeRuntimeAdapter('claude-code', [
        { path: '/one', source: 'path' },
        { path: '/two', source: 'custom' }
      ])
    ],
    databasePath: ':memory:',
    logger: false
  })
  t.after(() => server.close())
  const project = await server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: '/workspace/project' }
  })
  const projectId = project.json<{ id: string }>().id

  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/sessions`,
    payload: {
      adapterId: 'claude-code',
      initialInput: {
        clientMessageId: '3469774d-6862-4a19-985f-565651801a86',
        text: 'Start a session'
      }
    }
  })

  assert.equal(response.statusCode, 409)
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    'INSTALLATION_SELECTION_REQUIRED'
  )
})

test('keeps a durably admitted session when provider delivery later fails', async (t) => {
  const adapter = new FakeRuntimeAdapter()
  adapter.sendError = new Error('initial delivery failed')
  const server = buildServer({ adapters: [adapter], databasePath: ':memory:', logger: false })
  t.after(() => server.close())
  const projectResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: '/workspace/atomic-create' }
  })
  const projectId = projectResponse.json<{ id: string }>().id

  const created = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/sessions`,
    payload: {
      adapterId: 'claude-code',
      initialInput: {
        clientMessageId: 'b3c110a3-25b6-4c3f-9648-9b7dca16a771',
        text: 'This must fail atomically'
      }
    }
  })
  assert.equal(created.statusCode, 201)

  await new Promise<void>((resolve) => setImmediate(resolve))

  const sessions = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/sessions`
  })
  const listed = sessions.json<{ sessions: Array<{ inputQueue: unknown[] }> }>().sessions
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0]?.inputQueue, [])
  assert.equal(adapter.disposeCalls.length, 0)
})

test('manages queued inputs while a turn is active', async (t) => {
  const adapter = new FakeRuntimeAdapter()
  adapter.autoComplete = false
  adapter.descriptor.capabilities.steer = 'native'
  const server = buildServer({ adapters: [adapter], databasePath: ':memory:', logger: false })
  t.after(() => server.close())
  const project = await server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: '/workspace/input-queue' }
  })
  const projectId = project.json<{ id: string }>().id
  const created = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/sessions`,
    payload: {
      adapterId: 'claude-code',
      initialInput: { clientMessageId: randomUUID(), text: 'Keep this turn active' }
    }
  })
  const sessionId = created.json<{ session: { id: string } }>().session.id
  await new Promise<void>((resolve) => setImmediate(resolve))

  const secondId = randomUUID()
  const thirdId = randomUUID()
  for (const [clientMessageId, text] of [
    [secondId, 'second message'],
    [thirdId, 'third message']
  ]) {
    const admitted = await server.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/inputs`,
      payload: { input: { clientMessageId, text } }
    })
    assert.equal(admitted.statusCode, 202)
  }

  const replaced = await server.inject({
    method: 'PATCH',
    url: `/api/v1/sessions/${sessionId}/input-queue/${secondId}`,
    payload: {
      input: { clientMessageId: secondId, text: 'edited second message', delivery: 'queue' }
    }
  })
  assert.equal(replaced.statusCode, 204)
  const reordered = await server.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sessionId}/input-queue/order`,
    payload: { inputIds: [thirdId, secondId] }
  })
  assert.equal(reordered.statusCode, 204)
  const cancelled = await server.inject({
    method: 'DELETE',
    url: `/api/v1/sessions/${sessionId}/input-queue/${thirdId}`
  })
  assert.equal(cancelled.statusCode, 204)
  const sentNow = await server.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/input-queue/${secondId}/send`
  })
  assert.equal(sentNow.statusCode, 204)
  await new Promise<void>((resolve) => setImmediate(resolve))

  const session = await server.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` })
  assert.deepEqual(session.json<{ inputQueue: unknown[] }>().inputQueue, [])
  assert.equal(adapter.sendCalls.at(-1)?.options.kind, 'steer')
  assert.equal(adapter.sendCalls.at(-1)?.input.text, 'edited second message')
})
