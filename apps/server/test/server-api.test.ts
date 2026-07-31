import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
    payload: { adapterId: 'claude-code', initialInput: { text: 'Inspect this project' } }
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
    payload: { input: { text: 'Continue the inspection' } }
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
    payload: { adapterId: 'claude-code', initialInput: { text: 'Start a session' } }
  })

  assert.equal(response.statusCode, 409)
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    'INSTALLATION_SELECTION_REQUIRED'
  )
})

test('removes a newly created session when initial input delivery fails', async (t) => {
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

  const failed = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/sessions`,
    payload: { adapterId: 'claude-code', initialInput: { text: 'This must fail atomically' } }
  })
  assert.equal(failed.statusCode, 500)

  const sessions = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/sessions`
  })
  assert.deepEqual(sessions.json<{ sessions: unknown[] }>().sessions, [])
  assert.equal(adapter.disposeCalls.length, 1)
})
