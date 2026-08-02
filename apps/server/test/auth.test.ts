import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildServer } from '../src/app.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('enforces bearer token authentication on /api routes when configured', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-auth-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const server = buildServer({
    adapters: [new FakeRuntimeAdapter()],
    connectionToken: 'test-token',
    databasePath: join(directory, 'gateway.sqlite'),
    logger: false
  })
  t.after(() => server.close())

  const anonymous = await server.inject({ method: 'GET', url: '/api/v1/server' })
  assert.equal(anonymous.statusCode, 401)
  assert.equal(anonymous.json<{ error: { code: string } }>().error.code, 'UNAUTHORIZED')

  const wrongToken = await server.inject({
    method: 'GET',
    url: '/api/v1/server',
    headers: { authorization: 'Bearer wrong-token' }
  })
  assert.equal(wrongToken.statusCode, 401)

  const authenticated = await server.inject({
    method: 'GET',
    url: '/api/v1/server',
    headers: { authorization: 'Bearer test-token' }
  })
  assert.equal(authenticated.statusCode, 200)

  // 探活豁免认证
  const health = await server.inject({ method: 'GET', url: '/health' })
  assert.equal(health.statusCode, 200)
})

test('reports server identity through the onServerIdentity callback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-identity-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  let reported: string | undefined
  const server = buildServer({
    adapters: [new FakeRuntimeAdapter()],
    databasePath: join(directory, 'gateway.sqlite'),
    logger: false,
    onServerIdentity: (identity) => {
      reported = identity.id
    }
  })
  t.after(() => server.close())

  await server.ready()
  const response = await server.inject({ method: 'GET', url: '/api/v1/server' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json<{ hostId: string }>().hostId, reported)
})
