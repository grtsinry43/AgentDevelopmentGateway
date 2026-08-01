import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { asSessionId, createDefaultSessionExecutionSettings } from '@agent-gateway/core'
import { AdapterRegistry, RuntimeSessionManager } from '@agent-gateway/runtime'
import { ProjectRepository } from '../src/features/projects/repository.js'
import { ProjectService } from '../src/features/projects/service.js'
import { SessionRepository } from '../src/features/sessions/repository.js'
import { openGatewayDatabase } from '../src/infrastructure/database.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('identifies projects by host and normalized absolute path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-project-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const database = openGatewayDatabase(':memory:')
  t.after(() => database.close())
  const projects = new ProjectRepository(database)
  const sessions = new SessionRepository(database)
  const service = new ProjectService(
    projects,
    sessions,
    new RuntimeSessionManager(new AdapterRegistry([new FakeRuntimeAdapter()])),
    'a6ce6038-b3c8-40f8-bf6b-533fa10a7c40',
    {}
  )

  const created = await service.create({ path: `${directory}/` })
  assert.equal(created.path, directory)
  assert.equal(created.availability, 'available')
  await assert.rejects(service.create({ path: directory }), /already registered/)
  await assert.rejects(service.create({ path: 'relative/project' }), /must be absolute/)

  const execution = createDefaultSessionExecutionSettings()
  const fakeAdapter = new FakeRuntimeAdapter()
  sessions.create({
    session: {
      id: asSessionId('2c1ed1c2-311f-44bb-ae0d-0f34a946f0e9'),
      projectId: created.id,
      hostId: created.hostId,
      adapterId: 'claude-code',
      execution: { configured: execution, effective: execution, limitations: [] },
      controlRevision: 0,
      status: 'idle',
      lastEventSequence: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    capabilities: fakeAdapter.descriptor.capabilities
  })
  assert.throws(() => service.remove(created.id), /active sessions/)
})
