import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkspaceFileEvent } from '@agent-gateway/shared'
import { encodeWorkspaceFileSse } from '../src/features/files/routes.js'
import type { WorkspaceDirectoryLocation } from '../src/features/files/service.js'
import { WorkspaceFileWatchHub } from '../src/features/files/watch-hub.js'

const PROJECT_ID = '86b38f70-028c-4cf6-a283-ed2297385cd0'
const SUBSCRIPTION_ID = '95b18b4b-5b8c-4294-9ac0-c83a1cdf9e14'

test('encodes workspace file events and heartbeat frames', async () => {
  const event: WorkspaceFileEvent = {
    type: 'workspace.files.resync',
    projectId: PROJECT_ID,
    subscriptionId: SUBSCRIPTION_ID,
    timestamp: 1
  }
  const stream = encodeWorkspaceFileSse(replay([event]), 1_000)
  assert.match((await stream.next()).value ?? '', /event: workspace\.files\.resync/)
  assert.equal((await stream.next()).done, true)

  const heartbeat = encodeWorkspaceFileSse(pendingEvents(), 1)
  assert.equal((await heartbeat.next()).value, ': heartbeat\n\n')
  await heartbeat.return(undefined)
})

test('watches only subscribed directories and coalesces invalidations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-gateway-watch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  const errors: unknown[] = []
  const hub = new WorkspaceFileWatchHub(
    {
      directoryLocation: async (_projectId, path): Promise<WorkspaceDirectoryLocation> => ({
        absolutePath: path ? join(root, path) : root,
        relativePath: path
      })
    },
    (error) => errors.push(error)
  )
  t.after(() => hub.close())

  const events = await hub.open(PROJECT_ID, SUBSCRIPTION_ID)
  const iterator = events[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, 'workspace.files.resync')
  await hub.update(PROJECT_ID, SUBSCRIPTION_ID, ['src'])
  await wait(100)
  await Promise.all([
    writeFile(join(root, 'src', 'one.ts'), 'one'),
    writeFile(join(root, 'src', 'two.ts'), 'two')
  ])

  const invalidated = await withTimeout(iterator.next(), 3_000)
  assert.deepEqual(invalidated.value, {
    type: 'workspace.files.invalidated',
    projectId: PROJECT_ID,
    subscriptionId: SUBSCRIPTION_ID,
    paths: ['src'],
    timestamp: invalidated.value?.timestamp
  })
  assert.deepEqual(errors, [])
  await iterator.return?.()
})

async function* replay(events: WorkspaceFileEvent[]): AsyncGenerator<WorkspaceFileEvent> {
  yield* events
}

async function* pendingEvents(): AsyncGenerator<WorkspaceFileEvent> {
  yield* [] as WorkspaceFileEvent[]
  await new Promise(() => undefined)
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function withTimeout<T>(promise: Promise<T>, delayMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for file event')), delayMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
