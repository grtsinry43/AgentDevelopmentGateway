import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildServer } from '../src/app.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('lists project files through a canonical workspace-relative contract', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projectPath = join(directory, 'project')
  await mkdir(join(projectPath, 'src'), { recursive: true })
  await mkdir(join(projectPath, 'node_modules'))
  await mkdir(join(projectPath, '.git'))
  await mkdir(join(projectPath, '.idea'))
  await writeFile(join(projectPath, 'README.md'), '# project')
  await writeFile(join(projectPath, '.DS_Store'), 'noise')
  await symlink(directory, join(projectPath, 'external-link'))

  const server = buildServer({
    adapters: [new FakeRuntimeAdapter()],
    databasePath: join(directory, 'gateway.sqlite'),
    logger: false
  })
  t.after(() => server.close())

  const serverInfo = await server.inject({ method: 'GET', url: '/api/v1/server' })
  assert.equal(serverInfo.statusCode, 200)
  assert.equal(serverInfo.json<{ protocolVersion: number }>().protocolVersion, 6)
  assert.deepEqual(
    serverInfo
      .json<{ capabilities: string[] }>()
      .capabilities.filter((capability) => capability.startsWith('workspace.files.')),
    ['workspace.files.list', 'workspace.files.read', 'workspace.files.watch']
  )

  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: projectPath }
  })
  const projectId = created.json<{ id: string }>().id

  const root = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files`
  })
  assert.equal(root.statusCode, 200)
  assert.deepEqual(root.json<{ path: string }>().path, '')
  assert.deepEqual(
    root.json<{ entries: Array<{ name: string; kind: string; generated: boolean }> }>().entries,
    [
      { name: '.git', kind: 'directory', generated: false },
      { name: '.idea', kind: 'directory', generated: false },
      { name: 'node_modules', kind: 'directory', generated: true },
      { name: 'src', kind: 'directory', generated: false },
      { name: 'external-link', kind: 'symlink', generated: false },
      { name: 'README.md', kind: 'file', generated: false }
    ].map((entry) => ({ ...entry, path: entry.name }))
  )

  const nested = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files`,
    query: { path: 'src' }
  })
  assert.equal(nested.statusCode, 200)
  assert.deepEqual(nested.json(), { path: 'src', entries: [] })

  for (const [path, code, statusCode] of [
    ['..', 'INVALID_WORKSPACE_PATH', 400],
    ['/tmp', 'INVALID_WORKSPACE_PATH', 400],
    ['src/', 'INVALID_WORKSPACE_PATH', 400],
    ['external-link', 'INVALID_WORKSPACE_PATH', 422],
    ['README.md', 'NOT_A_DIRECTORY', 422],
    ['missing', 'FILE_NOT_FOUND', 404]
  ] as const) {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/files`,
      query: { path }
    })
    assert.equal(response.statusCode, statusCode, path)
    assert.equal(response.json<{ error: { code: string } }>().error.code, code, path)
  }

  const content = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files/content`,
    query: { path: 'README.md' }
  })
  assert.equal(content.statusCode, 200)
  assert.deepEqual(content.json(), {
    path: 'README.md',
    content: '# project',
    size: Buffer.byteLength('# project', 'utf8')
  })

  const binaryPath = join(projectPath, 'blob.bin')
  await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02]))
  const binary = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files/content`,
    query: { path: 'blob.bin' }
  })
  assert.equal(binary.statusCode, 422)
  assert.equal(binary.json<{ error: { code: string } }>().error.code, 'BINARY_FILE')

  const asDirectory = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files/content`,
    query: { path: 'src' }
  })
  assert.equal(asDirectory.statusCode, 422)
  assert.equal(asDirectory.json<{ error: { code: string } }>().error.code, 'NOT_A_FILE')
})
