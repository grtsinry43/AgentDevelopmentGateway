import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  asSessionId,
  type AdapterEvent,
  type SessionId,
} from '@agent-gateway/core'
import { CodexAdapter } from '../src/codex-adapter.js'
import {
  createFakeCodex,
  fakeCodexEnv,
  withTimeout,
} from './support/fake-codex.js'

test('maps turn/plan/updated into a provider-neutral task update', async (t) => {
  const event = await notificationEvent(t, 'turn-plan-updated.json')
  assert.equal(event.type, 'task.updated')
  if (event.type !== 'task.updated') return
  assert.equal(event.payload.update.kind, 'replace')
  if (event.payload.update.kind !== 'replace') return
  assert.equal(event.payload.update.explanation, 'Track the protocol work explicitly.')
  assert.deepEqual(
    event.payload.update.tasks.map(({ title, status }) => ({ title, status })),
    [
      { title: 'Inspect generated protocol types', status: 'completed' },
      { title: 'Map notifications into Core events', status: 'in_progress' },
      { title: 'Verify adapter behavior', status: 'pending' },
    ],
  )
})

test('maps SubAgentActivity items into subagent lifecycle events', async (t) => {
  const event = await notificationEvent(t, 'sub-agent-activity-started.json')
  assert.equal(event.type, 'subagent.started')
  if (event.type !== 'subagent.started') return
  assert.equal(event.payload.run.runtimeSubagentId, 'child-thread-1')
  assert.equal(event.payload.run.title, 'worker')
  assert.equal(event.payload.run.status, 'starting')
  assert.match(
    event.payload.run.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'wire contract requires UUID subagent run ids for desktop projection',
  )
  // agentPath is title/identity only — never the task prompt.
  assert.equal(event.payload.run.prompt, undefined)
})

test('recovers spawn prompt from CollabAgentToolCall onto later SubAgentActivity', async (t) => {
  const executable = await createFakeCodex(t)
  const adapter = new CodexAdapter()
  t.after(() => adapter.dispose())
  const connection = await adapter.connect({
    context: {
      hostId: 'local',
      env: fakeCodexEnv('notifications', {
        fixtures: ['collab-spawn-started.json', 'sub-agent-activity-after-spawn.json'],
      }),
    },
    installation: {
      path: executable,
      version: 'test',
      source: 'custom',
    },
  })
  const sessionId = asSessionId('contract-collab-then-activity') as SessionId
  await adapter.createSession({
    sessionId,
    projectPath: process.cwd(),
    connection,
  })
  const events = adapter.events(sessionId)[Symbol.asyncIterator]()
  assert.equal((await nextEvent(events, 'session.created')).type, 'session.created')
  assert.equal(
    (await nextEvent(events, 'session.status_changed')).type,
    'session.status_changed',
  )

  let runEvent: AdapterEvent | undefined
  for (let i = 0; i < 12; i += 1) {
    const event = await nextEvent(events, `recover-${i}`)
    if (event.type === 'subagent.started') {
      runEvent = event
      break
    }
  }
  assert.ok(runEvent)
  if (runEvent?.type !== 'subagent.started') return
  assert.equal(runEvent.payload.run.title, 'worker')
  assert.equal(runEvent.payload.run.prompt, 'Please introduce yourself briefly.')
})

test('maps CollabAgentToolCall spawn prompt into SubagentRun.prompt and child timeline', async (t) => {
  const executable = await createFakeCodex(t)
  const adapter = new CodexAdapter()
  t.after(() => adapter.dispose())
  const connection = await adapter.connect({
    context: {
      hostId: 'local',
      env: fakeCodexEnv('notifications', { fixtures: ['collab-spawn-completed.json'] }),
    },
    installation: {
      path: executable,
      version: 'test',
      source: 'custom',
    },
  })
  const sessionId = asSessionId('contract-collab-spawn') as SessionId
  await adapter.createSession({
    sessionId,
    projectPath: process.cwd(),
    connection,
  })
  const events = adapter.events(sessionId)[Symbol.asyncIterator]()
  assert.equal((await nextEvent(events, 'session.created')).type, 'session.created')
  assert.equal(
    (await nextEvent(events, 'session.status_changed')).type,
    'session.status_changed',
  )

  const seen: AdapterEvent[] = []
  for (let i = 0; i < 8; i += 1) {
    const event = await nextEvent(events, `collab-${i}`)
    seen.push(event)
    if (seen.some((item) => item.type === 'subagent.started' || item.type === 'subagent.updated')) {
      break
    }
  }

  const tool = seen.find((item) => item.type === 'tool.completed')
  assert.ok(tool)
  if (tool?.type !== 'tool.completed') return
  assert.equal(tool.payload.toolCall.name, 'spawnAgent')
  assert.equal(
    (tool.payload.toolCall.input as { prompt?: string }).prompt,
    'Please introduce yourself briefly.',
  )

  const runEvent = seen.find(
    (item) => item.type === 'subagent.started' || item.type === 'subagent.updated',
  )
  assert.ok(runEvent)
  if (runEvent?.type !== 'subagent.started' && runEvent?.type !== 'subagent.updated') return
  assert.equal(runEvent.payload.run.runtimeSubagentId, 'child-thread-1')
  assert.equal(runEvent.payload.run.prompt, 'Please introduce yourself briefly.')
  assert.equal(runEvent.payload.run.title, 'Delegated task')

  // Drain a few more for the attributed task text projection.
  let taskText: AdapterEvent | undefined
  for (let i = 0; i < 6; i += 1) {
    const event = await nextEvent(events, `task-${i}`)
    if (
      event.type === 'content.text.completed' &&
      event.attribution?.sourceKind === 'subagent' &&
      event.payload.text === 'Please introduce yourself briefly.'
    ) {
      taskText = event
      break
    }
  }
  assert.ok(taskText, 'child timeline should show the spawn task prompt')
})

test('maps thread/tokenUsage/updated totals and context window into usage.updated', async (t) => {
  const event = await notificationEvent(t, 'thread-token-usage-updated.json')
  assert.equal(event.type, 'usage.updated')
  if (event.type !== 'usage.updated') return
  assert.deepEqual(event.payload, {
    usage: {
      inputTokens: 1000,
      outputTokens: 320,
      cachedInputTokens: 240,
      cacheCreationInputTokens: 80,
      reasoningTokens: 120,
      totalTokens: 1440,
      contextWindow: 200000,
    },
  })
})

test('maps account/rateLimits/updated into normalized primary and secondary windows', async (t) => {
  const event = await notificationEvent(t, 'account-rate-limits-updated.json')
  assert.equal(event.type, 'usage.rate_limit_updated')
  if (event.type !== 'usage.rate_limit_updated') return
  assert.deepEqual(event.payload, {
    windows: [
      {
        window: 'primary',
        utilization: 0.42,
        resetsAt: 1785610800000,
      },
      {
        window: 'secondary',
        utilization: 0.17,
        resetsAt: 1786129200000,
      },
    ],
  })
})

test('surfaces a completed contextCompaction item as context.compacted', async (t) => {
  const event = await notificationEvent(t, 'context-compaction-completed.json')
  assert.equal(event.type, 'context.compacted')
  if (event.type !== 'context.compacted') return
  assert.ok(event.payload.reason === 'auto' || event.payload.reason === 'manual')
})

async function notificationEvent(
  t: TestContext,
  fixture: string,
): Promise<AdapterEvent> {
  const executable = await createFakeCodex(t)
  const adapter = new CodexAdapter()
  t.after(() => adapter.dispose())
  const connection = await adapter.connect({
    context: {
      hostId: 'local',
      env: fakeCodexEnv('notifications', { fixtures: [fixture] }),
    },
    installation: {
      path: executable,
      version: 'test',
      source: 'custom',
    },
  })
  const sessionId = asSessionId(`contract-${fixture}`) as SessionId
  await adapter.createSession({
    sessionId,
    projectPath: process.cwd(),
    connection,
  })
  const events = adapter.events(sessionId)[Symbol.asyncIterator]()
  assert.equal((await nextEvent(events, 'session.created')).type, 'session.created')
  assert.equal(
    (await nextEvent(events, 'session.status_changed')).type,
    'session.status_changed',
  )
  return nextEvent(events, fixture)
}

async function nextEvent(
  events: AsyncIterator<AdapterEvent>,
  label: string,
): Promise<AdapterEvent> {
  const result = await withTimeout(events.next(), label)
  assert.equal(result.done, false, `event stream ended before ${label}`)
  assert.ok(result.value, `event stream returned no value for ${label}`)
  return result.value
}
