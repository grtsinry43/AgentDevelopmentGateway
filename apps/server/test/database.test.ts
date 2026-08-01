import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ServerIdentityRepository } from '../src/features/server/repository.js'
import { openGatewayDatabase } from '../src/infrastructure/database.js'

test('migrates a file database and preserves server identity across reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-db-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const path = join(directory, 'gateway.sqlite')

  const firstDatabase = openGatewayDatabase(path)
  const firstIdentity = new ServerIdentityRepository(firstDatabase).getOrCreate()
  assert.equal(firstDatabase.pragma('foreign_keys', { simple: true }), 1)
  assert.deepEqual(firstDatabase.prepare('SELECT version FROM schema_migrations').all(), [
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 }
  ])
  firstDatabase.close()

  const secondDatabase = openGatewayDatabase(path)
  const secondIdentity = new ServerIdentityRepository(secondDatabase).getOrCreate()
  assert.equal(secondIdentity.id, firstIdentity.id)
  secondDatabase.close()
})
