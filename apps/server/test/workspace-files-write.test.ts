import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { buildServer } from '../src/app.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-files-write-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projectPath = join(directory, 'project')
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(projectPath, 'a.txt'), 'hello')
  await mkdir(join(projectPath, 'docs'))
  await writeFile(join(projectPath, 'docs', 'b.md'), '# b')

  const server = buildServer({
    adapters: [new FakeRuntimeAdapter()],
    databasePath: join(directory, 'gateway.sqlite'),
    logger: false
  })
  t.after(() => server.close())

  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: projectPath }
  })
  assert.equal(created.statusCode, 201)
  return { server, projectPath, projectId: created.json<{ id: string }>().id }
}

test('creates files and directories in the workspace', async (t) => {
  const { server, projectPath, projectId } = await setup(t)

  const createFile = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { path: 'notes/new.txt', kind: 'file' }
  })
  assert.equal(createFile.statusCode, 404)
  assert.equal(createFile.json<{ error: { code: string } }>().error.code, 'FILE_NOT_FOUND')

  await mkdir(join(projectPath, 'notes'))
  const createFileAgain = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { path: 'notes/new.txt', kind: 'file' }
  })
  assert.equal(createFileAgain.statusCode, 204)
  assert.equal((await lstat(join(projectPath, 'notes', 'new.txt'))).isFile(), true)

  const createDir = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { path: 'notes/sub', kind: 'directory' }
  })
  assert.equal(createDir.statusCode, 204)
  assert.equal((await lstat(join(projectPath, 'notes', 'sub'))).isDirectory(), true)

  const conflict = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { path: 'a.txt', kind: 'file' }
  })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json<{ error: { code: string } }>().error.code, 'PATH_EXISTS')
})

test('renames and moves workspace paths', async (t) => {
  const { server, projectPath, projectId } = await setup(t)

  const rename = await server.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { from: 'a.txt', to: 'renamed.txt' }
  })
  assert.equal(rename.statusCode, 204)
  assert.equal(await readFile(join(projectPath, 'renamed.txt'), 'utf8'), 'hello')
  await assert.rejects(lstat(join(projectPath, 'a.txt')), { code: 'ENOENT' })

  const moveIntoDir = await server.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { from: 'renamed.txt', to: 'docs/renamed.txt' }
  })
  assert.equal(moveIntoDir.statusCode, 204)
  assert.equal(await readFile(join(projectPath, 'docs', 'renamed.txt'), 'utf8'), 'hello')

  const intoSubtree = await server.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { from: 'docs', to: 'docs/deeper' }
  })
  assert.equal(intoSubtree.statusCode, 422)
  assert.equal(intoSubtree.json<{ error: { code: string } }>().error.code, 'INVALID_MOVE_TARGET')

  const ontoExisting = await server.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { from: 'docs/b.md', to: 'docs/renamed.txt' }
  })
  assert.equal(ontoExisting.statusCode, 409)

  const missingSource = await server.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { from: 'missing.txt', to: 'elsewhere.txt' }
  })
  assert.equal(missingSource.statusCode, 404)

  const selfMove = await server.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${projectId}/files`,
    payload: { from: 'docs/renamed.txt', to: 'docs/renamed.txt' }
  })
  assert.equal(selfMove.statusCode, 204)
})

test('copies files and directories', async (t) => {
  const { server, projectPath, projectId } = await setup(t)

  const copyFile = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files/copy`,
    payload: { from: 'a.txt', to: 'a-copy.txt' }
  })
  assert.equal(copyFile.statusCode, 204)
  assert.equal(await readFile(join(projectPath, 'a-copy.txt'), 'utf8'), 'hello')
  assert.equal(await readFile(join(projectPath, 'a.txt'), 'utf8'), 'hello')

  const copyDir = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files/copy`,
    payload: { from: 'docs', to: 'docs-backup' }
  })
  assert.equal(copyDir.statusCode, 204)
  assert.equal((await lstat(join(projectPath, 'docs-backup'))).isDirectory(), true)
  assert.equal(await readFile(join(projectPath, 'docs-backup', 'b.md'), 'utf8'), '# b')

  const ontoExisting = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files/copy`,
    payload: { from: 'a.txt', to: 'docs/b.md' }
  })
  assert.equal(ontoExisting.statusCode, 409)

  const intoSubtree = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files/copy`,
    payload: { from: 'docs', to: 'docs/deeper' }
  })
  assert.equal(intoSubtree.statusCode, 422)

  const missingSource = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files/copy`,
    payload: { from: 'missing', to: 'x' }
  })
  assert.equal(missingSource.statusCode, 404)
})

test('writes text content into an existing workspace file', async (t) => {
  const { server, projectPath, projectId } = await setup(t)

  const update = await server.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/files/content`,
    payload: { path: 'a.txt', content: 'updated' }
  })
  assert.equal(update.statusCode, 204)
  assert.equal(await readFile(join(projectPath, 'a.txt'), 'utf8'), 'updated')

  const writeDir = await server.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/files/content`,
    payload: { path: 'docs', content: 'x' }
  })
  assert.equal(writeDir.statusCode, 422)

  const writeMissing = await server.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/files/content`,
    payload: { path: 'nope.txt', content: 'x' }
  })
  assert.equal(writeMissing.statusCode, 404)
})

test('deletes files and directories recursively', async (t) => {
  const { server, projectPath, projectId } = await setup(t)

  const deleteFile = await server.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${projectId}/files`,
    query: { path: 'a.txt' }
  })
  assert.equal(deleteFile.statusCode, 204)
  await assert.rejects(lstat(join(projectPath, 'a.txt')), { code: 'ENOENT' })

  const deleteDir = await server.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${projectId}/files`,
    query: { path: 'docs' }
  })
  assert.equal(deleteDir.statusCode, 204)
  await assert.rejects(lstat(join(projectPath, 'docs')), { code: 'ENOENT' })

  const deleteRoot = await server.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${projectId}/files`,
    query: { path: '' }
  })
  assert.equal(deleteRoot.statusCode, 400)

  const deleteMissing = await server.inject({
    method: 'DELETE',
    url: `/api/v1/projects/${projectId}/files`,
    query: { path: 'nope' }
  })
  assert.equal(deleteMissing.statusCode, 404)
})

test('downloads single files and zips directories', async (t) => {
  const { server, projectId } = await setup(t)

  const fileDownload = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files/download`,
    query: { path: 'a.txt' }
  })
  assert.equal(fileDownload.statusCode, 200)
  assert.equal(fileDownload.headers['content-type'], 'application/octet-stream')
  assert.equal(fileDownload.rawPayload.toString('utf8'), 'hello')

  const dirDownload = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files/download`,
    query: { path: 'docs' }
  })
  assert.equal(dirDownload.statusCode, 200)
  assert.equal(dirDownload.headers['content-type'], 'application/zip')
  assert.equal(dirDownload.rawPayload.subarray(0, 2).toString('latin1'), 'PK')

  const missingDownload = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/files/download`,
    query: { path: 'nope' }
  })
  assert.equal(missingDownload.statusCode, 404)
})

test('rejects invalid write paths through the canonical contract', async (t) => {
  const { server, projectId } = await setup(t)

  for (const [path, code] of [
    ['..', 'INVALID_WORKSPACE_PATH'],
    ['/abs', 'INVALID_WORKSPACE_PATH'],
    ['a/../b', 'INVALID_WORKSPACE_PATH'],
    ['', 'VALIDATION_ERROR']
  ] as const) {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path, kind: 'file' }
    })
    assert.equal(response.statusCode, 400, path)
    assert.equal(response.json<{ error: { code: string } }>().error.code, code, path)
  }
})
