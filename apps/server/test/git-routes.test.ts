import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { GitRepositoryState } from '@agent-gateway/shared'
import { buildServer } from '../src/app.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

const execFileAsync = promisify(execFile)

test('supports unborn repositories, literal paths, diff, stage, unstage and commit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-git-unborn-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projectPath = join(directory, 'project')
  await mkdir(projectPath)
  const server = buildServer({
    adapters: [new FakeRuntimeAdapter()],
    databasePath: join(directory, 'gateway.sqlite'),
    logger: false
  })
  t.after(() => server.close())
  const projectId = await createProject(server, projectPath)

  const nonRepository = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/git`
  })
  assert.equal(nonRepository.statusCode, 422)
  assert.equal(nonRepository.json<{ error: { code: string } }>().error.code, 'GIT_NOT_REPOSITORY')

  await git(projectPath, ['init', '-b', 'main'])
  await git(projectPath, ['config', 'user.name', 'Gateway Test'])
  await git(projectPath, ['config', 'user.email', 'gateway@example.test'])
  const specialPath = '--odd\nname.txt'
  await writeFile(join(projectPath, specialPath), 'first\nsecond\n')

  const staged = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/git/stage`,
    payload: { paths: [specialPath] }
  })
  assert.equal(staged.statusCode, 204, staged.body)

  const stagedState = await gitState(server, projectId)
  assert.equal(stagedState.branch.name, 'main')
  assert.equal(stagedState.branch.oid, undefined)
  assert.deepEqual(
    stagedState.changes.map(({ area, path, status }) => ({ area, path, status })),
    [{ area: 'staged', path: specialPath, status: 'added' }]
  )

  const diff = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/git/diff`,
    query: { path: specialPath, area: 'staged' }
  })
  assert.equal(diff.statusCode, 200)
  const changed = diff.json<{ change: { kind: string; additions: number; hunks: unknown[] } }>()
    .change
  assert.equal(changed.kind, 'create')
  assert.equal(changed.additions, 2)
  assert.equal(changed.hunks.length, 1)

  const unstaged = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/git/unstage`,
    payload: { paths: [specialPath] }
  })
  assert.equal(unstaged.statusCode, 204)
  assert.equal((await gitState(server, projectId)).changes[0]?.area, 'untracked')

  const invalidPath = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/git/stage`,
    payload: { paths: ['../outside'] }
  })
  assert.equal(invalidPath.statusCode, 400)

  await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/git/stage`,
    payload: { paths: [specialPath] }
  })
  const committed = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/git/commit`,
    payload: { message: 'feat: support unusual paths' }
  })
  assert.equal(committed.statusCode, 201)
  assert.match(committed.json<{ oid: string }>().oid, /^[0-9a-f]{40}$/)
  assert.deepEqual((await gitState(server, projectId)).changes, [])
})

test('reports upstream divergence, split file states and publishes Git invalidations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-git-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projectPath = join(directory, 'project')
  const remotePath = join(directory, 'remote.git')
  const otherPath = join(directory, 'other')
  await mkdir(projectPath)
  await git(projectPath, ['init', '-b', 'main'])
  await configureIdentity(projectPath)
  await writeFile(join(projectPath, 'tracked.txt'), 'base\n')
  await writeFile(join(projectPath, 'rename-source.txt'), 'rename\n')
  await writeFile(join(projectPath, 'binary.bin'), Buffer.from([0, 1, 2]))
  await git(projectPath, ['add', '.'])
  await git(projectPath, ['commit', '-m', 'initial'])
  await git(directory, ['init', '--bare', remotePath])
  await git(projectPath, ['remote', 'add', 'origin', remotePath])
  await git(projectPath, ['push', '-u', 'origin', 'main'])

  await git(directory, ['clone', remotePath, otherPath])
  await configureIdentity(otherPath)
  await writeFile(join(otherPath, 'tracked.txt'), 'remote\n')
  await git(otherPath, ['add', '.'])
  await git(otherPath, ['commit', '-m', 'remote'])
  await git(otherPath, ['push'])

  await writeFile(join(projectPath, 'tracked.txt'), 'local\n')
  await git(projectPath, ['add', 'tracked.txt'])
  await git(projectPath, ['commit', '-m', 'local'])
  await git(projectPath, ['fetch', 'origin'])
  await git(projectPath, ['merge', 'origin/main']).then(
    () => assert.fail('Expected a merge conflict'),
    (error: unknown) => assert.equal(exitCode(error), 1)
  )
  await git(projectPath, ['mv', 'rename-source.txt', 'rename-target.txt'])
  await writeFile(join(projectPath, 'rename-target.txt'), 'rename\nworking\n')
  await writeFile(join(projectPath, 'untracked.txt'), 'new\n')
  await writeFile(join(projectPath, 'binary.bin'), Buffer.from([0, 1, 3]))

  const server = buildServer({
    adapters: [new FakeRuntimeAdapter()],
    databasePath: join(directory, 'gateway.sqlite'),
    logger: false
  })
  t.after(() => server.close())
  const projectId = await createProject(server, projectPath)
  const state = await gitState(server, projectId)
  assert.equal(state.branch.name, 'main')
  assert.equal(state.branch.upstream, 'origin/main')
  assert.equal(state.branch.ahead, 1)
  assert.equal(state.branch.behind, 1)
  assert.equal(
    state.changes.some((change) => change.path === 'rename-target.txt' && change.area === 'staged'),
    true
  )
  assert.equal(
    state.changes.some(
      (change) => change.path === 'rename-target.txt' && change.area === 'unstaged'
    ),
    true
  )
  assert.equal(
    state.changes.some((change) => change.path === 'untracked.txt' && change.area === 'untracked'),
    true
  )
  assert.equal(
    state.changes.some((change) => change.path === 'tracked.txt' && change.area === 'conflict'),
    true
  )
  const binaryChange = state.changes.find(
    (change) => change.path === 'binary.bin' && change.area === 'unstaged'
  )
  assert.equal(binaryChange?.binary, true)
  const binaryDiff = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/git/diff`,
    query: { path: 'binary.bin', area: 'unstaged' }
  })
  assert.equal(binaryDiff.statusCode, 200)
  assert.equal(binaryDiff.json<{ change: { binary?: boolean } }>().change.binary, true)

  await server.listen({ host: '127.0.0.1', port: 0 })
  const address = server.addresses()[0]
  assert.ok(address)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/projects/${projectId}/git/events`,
    { signal: controller.signal, headers: { accept: 'text/event-stream' } }
  )
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const eventPromise = readGitEvent(response.body, controller.signal)
  await new Promise((resolve) => setTimeout(resolve, 100))
  await writeFile(join(projectPath, 'rename-target.txt'), 'rename\nworking\nchanged again\n')
  const event = await withTimeout(eventPromise, 5_000)
  assert.equal(event.type, 'workspace.git.changed')
  assert.equal(event.projectId, projectId)
})

async function createProject(
  server: ReturnType<typeof buildServer>,
  projectPath: string
): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { path: projectPath }
  })
  assert.equal(response.statusCode, 201)
  return response.json<{ id: string }>().id
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C' }
  })
}

async function configureIdentity(cwd: string): Promise<void> {
  await git(cwd, ['config', 'user.name', 'Gateway Test'])
  await git(cwd, ['config', 'user.email', 'gateway@example.test'])
}

function exitCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'number' ? error.code : undefined
}

async function gitState(
  server: ReturnType<typeof buildServer>,
  projectId: string
): Promise<GitRepositoryState> {
  const response = await server.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/git`
  })
  assert.equal(response.statusCode, 200, response.body)
  return response.json<GitRepositoryState>()
}

async function readGitEvent(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): Promise<{ type: string; projectId: string }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done) throw new Error('Git event stream closed')
      buffer += decoder.decode(next.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) return JSON.parse(data) as { type: string; projectId: string }
        boundary = buffer.indexOf('\n\n')
      }
    }
    throw new Error('Git event stream aborted')
  } finally {
    reader.releaseLock()
  }
}

async function withTimeout<T>(promise: Promise<T>, delayMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for Git event')), delayMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
