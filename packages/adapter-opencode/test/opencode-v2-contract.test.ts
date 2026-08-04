import assert from 'node:assert/strict'
import test from 'node:test'
import { asSessionId, asTurnId, type AdapterEvent } from '@agent-gateway/core'
import { OpenCodeAdapter } from '../src/opencode-adapter.js'
import {
  assistantMessageId,
  expectedV2Paths,
  existingSessionId,
  globalEvents,
  nativeSessionId,
  projectPath,
  replayEvents,
} from './fixtures/opencode-v2.js'
import { collectUntil, createV2Harness, waitForRequest } from './support/v2-harness.js'

test('advertises the OpenCode v2 transport with fork and native rewind', async () => {
  const adapter = new OpenCodeAdapter()
  const capabilities = await adapter.getCapabilities()

  assert.equal(adapter.descriptor.protocolVersion, 'http-sse-v2')
  assert.equal(capabilities.features['session.resume'], true)
  // v2 has POST /session/:id/fork (reference-verified), so fork is advertised.
  assert.equal(capabilities.features['session.fork'], true)
  assert.equal(adapter.descriptor.capabilities.features['session.fork'], true)
  // revert/cleanup gives native in-place rewind.
  assert.equal(capabilities.rewind, 'native')
  assert.equal(capabilities.features['changes.revert'], true)
})

test('fixtures use official session routes plus v2 session.next envelopes', () => {
  // Hybrid transport: v2 create/prompt/replay + official abort/status/todo/global bus.
  assert.ok(expectedV2Paths.create.startsWith('/api/'))
  assert.ok(expectedV2Paths.resume.startsWith('/api/'))
  assert.ok(expectedV2Paths.prompt.startsWith('/api/'))
  assert.ok(expectedV2Paths.replay.startsWith('/api/'))
  assert.equal(expectedV2Paths.interrupt, `/session/${nativeSessionId}/abort`)
  assert.ok(globalEvents.some((event) => event.type === 'permission.v2.asked'))
  assert.ok(globalEvents.some((event) => event.type === 'question.v2.asked'))
  assert.ok(globalEvents.some((event) => event.type === 'session.next.text.delta' && !event.durable))
  assert.ok(globalEvents.some((event) => event.type === 'session.next.reasoning.delta' && !event.durable))
  assert.ok(globalEvents.some((event) => event.type === 'session.next.tool.input.delta' && !event.durable))
  assert.ok(globalEvents.some((event) => event.type === 'session.next.compaction.delta' && !event.durable))
  assert.equal(
    globalEvents.some((event) => event.type === 'todo.updated' && event.durable),
    false,
    'todo.updated is live-only in OpenCode; must not be durable',
  )
  assert.ok(replayEvents.every((event) => event.type.startsWith('session.next.') && event.durable))
  assert.ok(replayEvents.every((event) => event.durable?.aggregateID === existingSessionId))
})

test('creates through v2 and preserves prompt delivery, resume, and admittedSeq', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-create')
  try {
    const handle = await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
      model: { model: 'openai/gpt-test', reasoningEffort: 'high' },
    })
    assert.equal(handle.runtimeSessionId, nativeSessionId)

    const createRequest = await waitForRequest(
      harness,
      (request) => request.method === 'POST' && request.path === expectedV2Paths.create,
    )
    assert.deepEqual(createRequest.body, {
      model: { id: 'gpt-test', providerID: 'openai', variant: 'high' },
      location: { directory: harness.directory },
    })

    const gatewayMessageId = '6689c1d1-aff3-417a-b941-b5d6460a7782'
    const result = await harness.adapter.send(
      sessionId,
      {
        clientMessageId: gatewayMessageId,
        text: 'queued contract prompt',
        delivery: 'queue',
        admitOnly: true,
      },
      { turnId: asTurnId('turn-admitted'), kind: 'start-turn' },
    )

    const promptRequest = await waitForRequest(
      harness,
      (request) => request.method === 'POST' && request.path === expectedV2Paths.prompt,
    )
    assert.deepEqual(promptRequest.body, {
      id: `msg_${gatewayMessageId}`,
      prompt: { text: 'queued contract prompt' },
      delivery: 'queue',
      resume: false,
    })
    assert.deepEqual(result.providerReceipt, {
      providerInputId: 'msg_user_contract',
      providerSequence: 42,
      raw: {
        admittedSeq: 42,
        id: 'msg_user_contract',
        sessionID: nativeSessionId,
        prompt: { text: 'queued contract prompt' },
        delivery: 'queue',
        timeCreated: 1_754_000_000_001,
      },
    })
  } finally {
    await harness.close()
  }
})

test('resumes per-session durable events after the requested replay sequence', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-replay')
  try {
    await harness.adapter.resumeSession({
      sessionId,
      projectPath: harness.directory,
      runtimeSessionId: existingSessionId,
      connection: harness.connection,
      cursor: { by: 'sequence', sequence: 7 },
    })

    const replayRequest = await waitForRequest(
      harness,
      (request) =>
        request.method === 'GET' &&
        request.path === `/api/session/${existingSessionId}/event` &&
        request.search === '?after=7',
    )
    assert.equal(`${replayRequest.path}${replayRequest.search}`, expectedV2Paths.replay)

    const events = await collectUntil(
      harness.adapter.events(sessionId),
      (collected) => collected.some((event) => event.nativeRef?.eventId === replayEvents.at(-1)?.id),
    )
    const nativeIds = new Set(events.map((event) => event.nativeRef?.eventId))
    for (const event of replayEvents) assert.ok(nativeIds.has(event.id), `missing replay event ${event.id}`)
    assert.equal(
      events.filter((event) => event.nativeRef?.eventId === replayEvents[0]?.id).length,
      1,
    )
    const settled = events.find(
      (event) => event.nativeRef?.eventType === 'session.next.step.ended',
    )
    assert.equal(
      (settled as AdapterEvent & { schemaVersion?: number } | undefined)?.schemaVersion,
      2,
    )
  } finally {
    await harness.close()
  }
})

test('maps v2 text, reasoning, and tool started-delta-ended lifecycles', async () => {
  const { harness, events } = await resumeAndCollect((collected) =>
    collected.some((event) => event.nativeRef?.eventType === 'session.next.tool.success'),
  )
  try {
    assertEventTypes(events, [
      'content.text.started',
      'content.text.delta',
      'content.text.completed',
      'content.reasoning.started',
      'content.reasoning.delta',
      'content.reasoning.completed',
      'tool.started',
      'tool.input_delta',
      'tool.output_delta',
      'tool.completed',
    ])

    const text = events.find((event) => event.type === 'content.text.completed')
    assert.deepEqual(text?.payload, {
      blockId: `${assistantMessageId}:text-1`,
      text: 'hello world',
    })
    const reasoning = events.find((event) => event.type === 'content.reasoning.completed')
    assert.deepEqual(reasoning?.payload, {
      blockId: `${assistantMessageId}:reasoning-1`,
      text: 'inspect result',
    })
    const tool = events.find((event) => event.type === 'tool.completed')
    assert.equal(tool?.payload.toolCall.id, 'call-1')
    assert.equal(tool?.payload.toolCall.status, 'completed')
    assert.equal(tool?.payload.toolCall.providerExecuted, true)
    assert.deepEqual(tool?.payload.toolCall.presentation?.target, {
      kind: 'command',
      value: 'pwd',
    })
    assert.equal(tool?.payload.toolCall.presentation?.resultText, projectPath)
  } finally {
    await harness.close()
  }
})

test('maps failed tools and preserves native retry, switch, shell, and revert events', async () => {
  const { harness, events } = await resumeAndCollect((collected) =>
    collected.some((event) => event.nativeRef?.eventType === 'session.next.step.failed'),
  )
  try {
    const failedTool = events.find(
      (event) => event.type === 'tool.completed' && event.payload.toolCall.id === 'call-2',
    )
    assert.ok(failedTool?.type === 'tool.completed')
    assert.equal(failedTool.payload.toolCall.status, 'error')
    assert.equal(failedTool.payload.toolCall.providerExecuted, false)
    assert.deepEqual(failedTool.payload.toolCall.result, { path: 'missing.txt' })
    assert.equal(failedTool.payload.toolCall.error?.message, 'missing file')

    const warning = events.find((event) => event.type === 'runtime.warning')
    assert.ok(warning?.type === 'runtime.warning')
    assert.equal(warning.payload.error.message, 'rate limited')
    assert.equal(warning.payload.error.retriable, true)

    const extensions = new Set(
      events
        .filter((event) => event.type === 'runtime.extension')
        .map((event) => event.nativeRef?.eventType),
    )
    for (const nativeType of [
      'session.next.model.switched',
      'session.next.agent.switched',
      'session.next.shell.started',
      'session.next.shell.ended',
      'session.next.revert.cleared',
    ]) {
      assert.ok(extensions.has(nativeType), `missing extension ${nativeType}`)
    }
  } finally {
    await harness.close()
  }
})

test('maps permission.v2, question.v2, todos, step settlement, and compaction', async () => {
  const { harness, events } = await resumeAndCollect((collected) =>
    collected.some((event) => event.nativeRef?.eventType === 'session.next.step.failed') &&
      collected.some((event) => event.type === 'changes.updated'),
  )
  try {
    assertEventTypes(events, [
      'interaction.permission_requested',
      'interaction.question_requested',
      'task.updated',
      'usage.updated',
      'changes.updated',
      'turn.failed',
      'context.compacted',
    ])
    const changes = events.find((event) => event.type === 'changes.updated')
    assert.equal(changes?.type, 'changes.updated')
    if (changes?.type === 'changes.updated') {
      assert.equal(changes.payload.changeSet.files[0]?.path, 'README.md')
      assert.equal(changes.payload.changeSet.files[0]?.kind, 'modify')
    }

    const todo = events.find((event) => event.type === 'task.updated')
    assert.equal(todo?.type, 'task.updated')
    if (todo?.type === 'task.updated') {
      assert.equal(todo.payload.update.kind, 'replace')
      if (todo.payload.update.kind === 'replace') {
        assert.deepEqual(
          todo.payload.update.tasks.map(({ title, status, priority }) => ({
            title,
            status,
            priority,
          })),
          [
            { title: 'Map OpenCode todos', status: 'completed', priority: 'high' },
            { title: 'Wire Desktop projection', status: 'in_progress', priority: 'medium' },
            { title: 'Skip unsupported subagent events', status: 'pending', priority: 'low' },
          ],
        )
      }
    }

    const permission = events.find((event) => event.type === 'interaction.permission_requested')
    assert.equal(permission?.payload.request.toolName, 'bash')
    assert.deepEqual(permission?.payload.request.resources, ['pwd'])
    assert.equal(permission?.payload.request.toolCallId, 'call-1')

    const question = events.find((event) => event.type === 'interaction.question_requested')
    assert.equal(question?.payload.request.questions[0]?.header, 'Mode')
    assert.equal(question?.payload.request.questions[0]?.allowCustom, true)
    assert.equal(question?.payload.request.questions[0]?.options?.[1]?.label, 'Safe')

    const usage = events.find((event) => event.type === 'usage.updated')
    assert.deepEqual(usage?.payload.usage, {
      inputTokens: 120,
      outputTokens: 30,
      reasoningTokens: 10,
      cachedInputTokens: 40,
      cacheCreationInputTokens: 5,
      totalTokens: 160,
      costUsd: 0.0125,
    })

    const compacted = events.find((event) => event.type === 'context.compacted')
    assert.deepEqual(compacted?.payload, { reason: 'auto', summary: 'complete summary' })
    const failed = events.find((event) => event.type === 'turn.failed')
    assert.equal(failed?.payload.error.message, 'provider exploded')
    assert.equal(failed?.nativeRef?.eventType, 'session.next.step.failed')
  } finally {
    await harness.close()
  }
})

test('resolves permission and question interactions through exact v2 routes', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-interactions')
  try {
    await harness.adapter.resumeSession({
      sessionId,
      projectPath: harness.directory,
      runtimeSessionId: existingSessionId,
      connection: harness.connection,
      cursor: { by: 'sequence', sequence: 7 },
    })
    const events = await collectUntil(
      harness.adapter.events(sessionId),
      (collected) =>
        collected.some((event) => event.type === 'interaction.permission_requested') &&
        collected.some((event) => event.type === 'interaction.question_requested'),
    )
    const permission = events.find((event) => event.type === 'interaction.permission_requested')
    const question = events.find((event) => event.type === 'interaction.question_requested')
    assert.ok(permission?.type === 'interaction.permission_requested')
    assert.ok(question?.type === 'interaction.question_requested')

    await harness.adapter.resolveInteraction(sessionId, {
      kind: 'tool_permission',
      id: permission.payload.request.id,
      decision: { behavior: 'allow', scope: 'session' },
    })
    const answers = Object.fromEntries(
      question.payload.request.questions.map((item) => [item.id, ['Safe']]),
    )
    await harness.adapter.resolveInteraction(sessionId, {
      kind: 'question',
      id: question.payload.request.id,
      answers,
    })

    const permissionRequest = await waitForRequest(
      harness,
      (request) => request.path.endsWith('/permission/per_contract/reply'),
    )
    assert.deepEqual(permissionRequest.body, { reply: 'always' })
    const questionRequest = await waitForRequest(
      harness,
      (request) => request.path.endsWith('/question/que_contract/reply'),
    )
    assert.deepEqual(questionRequest.body, { answers: [['Safe']] })
  } finally {
    await harness.close()
  }
})

test('rejects questions through the independent v2 reject route', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-question-reject')
  try {
    await harness.adapter.resumeSession({
      sessionId,
      projectPath: harness.directory,
      runtimeSessionId: existingSessionId,
      connection: harness.connection,
    })
    const events = await collectUntil(
      harness.adapter.events(sessionId),
      (collected) => collected.some((event) => event.type === 'interaction.question_requested'),
    )
    const question = events.find((event) => event.type === 'interaction.question_requested')
    assert.ok(question?.type === 'interaction.question_requested')
    await harness.adapter.resolveInteraction(sessionId, {
      kind: 'question_rejected',
      id: question.payload.request.id,
    })
    const request = await waitForRequest(
      harness,
      (entry) => entry.path.endsWith('/question/que_contract/reject'),
    )
    assert.equal(request.body, undefined)
  } finally {
    await harness.close()
  }
})

test('maps live todo.updated from the global bus during an active session', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-live-todo')
  const turnId = asTurnId('turn-v2-live-todo')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    const eventsPromise = collectUntil(
      harness.adapter.events(sessionId),
      (collected) => collected.some((event) => event.type === 'task.updated'),
    )
    await harness.adapter.send(
      sessionId,
      { clientMessageId: 'msg_live_todo', text: 'create a todo' },
      { turnId, kind: 'start-turn' },
    )
    const events = await eventsPromise
    const todo = events.find((event) => event.type === 'task.updated')
    assert.equal(todo?.type, 'task.updated')
    if (todo?.type === 'task.updated' && todo.payload.update.kind === 'replace') {
      assert.deepEqual(
        todo.payload.update.tasks.map(({ title, status, priority }) => ({
          title,
          status,
          priority,
        })),
        [{ title: 'Live todo from prompt', status: 'in_progress', priority: 'high' }],
      )
    }
    assert.equal(
      (await harness.requests()).some((request) =>
        request.path === `/session/${nativeSessionId}/todo`,
      ),
      true,
      'createSession should hydrate todos via GET /session/:id/todo',
    )
  } finally {
    await harness.close()
  }
})

test('settles a synthetic turn when OpenCode emits session.status idle', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-wait')
  const turnId = asTurnId('turn-v2-wait')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    await harness.adapter.send(
      sessionId,
      { clientMessageId: 'msg_wait_contract', text: 'wait for completion' },
      { turnId, kind: 'start-turn' },
    )
    const events = await collectUntil(
      harness.adapter.events(sessionId),
      (collected) => collected.some((event) => event.type === 'turn.completed'),
    )
    assertEventTypes(events, ['turn.started', 'turn.completed'])
    const runningIndex = events.findIndex(
      (event) => event.type === 'session.status_changed' && event.payload.status === 'running',
    )
    const completedIndex = events.findIndex((event) => event.type === 'turn.completed')
    assert.ok(runningIndex >= 0, 'turn must publish session.status_changed running')
    assert.ok(runningIndex < completedIndex, 'running must precede turn.completed')
    const completed = events.find((event) => event.type === 'turn.completed')
    assert.equal(completed?.payload.status, 'completed')
    assert.equal(
      (await harness.requests()).some((request) => request.path.endsWith('/wait')),
      false,
    )
  } finally {
    await harness.close()
  }
})

test('settles a synthetic turn by polling /session/status when SSE idle is absent', async () => {
  const harness = await createV2Harness({ settleMode: 'status-poll' })
  const sessionId = asSessionId('gateway-v2-status-poll')
  const turnId = asTurnId('turn-v2-status-poll')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    await harness.adapter.send(
      sessionId,
      { clientMessageId: 'msg_status_poll_contract', text: 'wait via status poll' },
      { turnId, kind: 'start-turn' },
    )
    const events = await collectUntil(
      harness.adapter.events(sessionId),
      (collected) => collected.some((event) => event.type === 'turn.completed'),
      2_000,
    )
    const completed = events.find((event) => event.type === 'turn.completed')
    assert.equal(completed?.payload.status, 'completed')
    assert.equal(
      (await harness.requests()).some((request) => request.path === '/session/status'),
      true,
    )
    assert.equal(
      (await harness.requests()).some((request) => request.path.endsWith('/wait')),
      false,
    )
  } finally {
    await harness.close()
  }
})

test('settles after runner live activity even when /session/status never shows busy', async () => {
  const harness = await createV2Harness({ settleMode: 'step-then-idle' })
  const sessionId = asSessionId('gateway-v2-step-idle')
  const turnId = asTurnId('turn-v2-step-idle')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    await harness.adapter.send(
      sessionId,
      { clientMessageId: 'msg_step_idle_contract', text: 'step then idle' },
      { turnId, kind: 'start-turn' },
    )
    const events = await collectUntil(
      harness.adapter.events(sessionId),
      (collected) => collected.some((event) => event.type === 'turn.completed'),
      2_000,
    )
    const completed = events.find((event) => event.type === 'turn.completed')
    assert.equal(completed?.payload.status, 'completed')
    assert.equal(
      events.some((event) => event.type === 'session.status_changed' && event.payload.status === 'idle'),
      true,
    )
  } finally {
    await harness.close()
  }
})

test('does not settle from prompt.admitted while status map is still empty', async () => {
  const harness = await createV2Harness({ settleMode: 'admit-before-busy' })
  const sessionId = asSessionId('gateway-v2-admit-gap')
  const turnId = asTurnId('turn-v2-admit-gap')
  const collected: AdapterEvent[] = []
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    const iterator = harness.adapter.events(sessionId)[Symbol.asyncIterator]()
    const pump = (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        collected.push(next.value)
      }
    })()

    await harness.adapter.send(
      sessionId,
      { clientMessageId: 'msg_admit_gap_contract', text: 'admit then busy' },
      { turnId, kind: 'start-turn' },
    )

    // First status poll is at 250ms; admit lands with an empty status map until 500ms.
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(
      collected.some((event) => event.type === 'turn.completed'),
      false,
      'turn must stay open through the admit→busy gap',
    )

    const deadline = Date.now() + 2_500
    while (!collected.some((event) => event.type === 'turn.completed')) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for turn.completed: ${JSON.stringify(collected)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const completed = collected.find((event) => event.type === 'turn.completed')
    assert.equal(completed?.payload.status, 'completed')
    assert.equal(
      (await harness.requests()).some((request) => request.path === '/session/status'),
      true,
    )
    void pump
  } finally {
    await harness.close()
  }
})

test('interrupts the native session and terminates the active synthetic turn', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-interrupt')
  const turnId = asTurnId('turn-v2-interrupt')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    await harness.adapter.send(
      sessionId,
      { clientMessageId: 'msg_interrupt_contract', text: 'interrupt me' },
      { turnId, kind: 'start-turn' },
    )
    await harness.adapter.interrupt(sessionId)
    const events = await collectUntil(
      harness.adapter.events(sessionId),
      (collected) =>
        collected.some(
          (event) => event.type === 'turn.completed' && event.payload.status === 'interrupted',
        ),
    )
    const completed = events.find((event) => event.type === 'turn.completed')
    assert.equal(completed?.payload.status, 'interrupted')
    await waitForRequest(
      harness,
      (request) => request.path === `/session/${nativeSessionId}/abort`,
    )
  } finally {
    await harness.close()
  }
})

test('switches models through v2 and advertises only implemented capabilities', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-model')
  try {
    await harness.adapter.resumeSession({
      sessionId,
      projectPath: harness.directory,
      runtimeSessionId: existingSessionId,
      connection: harness.connection,
    })
    await harness.adapter.setModel(sessionId, {
      model: 'openai/gpt-test',
      reasoningEffort: 'high',
    })
    const request = await waitForRequest(
      harness,
      (entry) => entry.path === `/api/session/${existingSessionId}/model`,
    )
    assert.deepEqual(request.body, {
      model: { id: 'gpt-test', providerID: 'openai', variant: 'high' },
    })

    const capabilities = await harness.adapter.getCapabilities()
    assert.equal(capabilities.steer, 'native')
    assert.equal(capabilities.execution.update, 'unsupported')
  assert.equal(capabilities.features['work-mode.plan'], false)
  assert.equal(capabilities.features['task.todo'], true)
  assert.equal(capabilities.features['agent.subagent'], false)
  assert.equal(capabilities.features['context.session_injection'], false)
  assert.equal(capabilities.features['context.turn_injection'], false)
    assert.equal('forkSession' in harness.adapter, false)
    assert.equal('configureExecution' in harness.adapter, false)
  } finally {
    await harness.close()
  }
})

test('reverts natively by resolving the target user message id from clientMessageId', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-rewind')
  try {
    const handle = await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
      model: { model: 'openai/gpt-test' },
    })
    assert.equal(handle.runtimeSessionId, nativeSessionId)
    await waitForRequest(harness, (r) => r.method === 'POST' && r.path === expectedV2Paths.create)

    const clientMessageId = '6689c1d1-aff3-417a-b941-b5d6460a7782'
    const preview = await harness.adapter.rewindSession({
      sessionId,
      projectPath: harness.directory,
      target: { by: 'message', messageUuid: 'input-1', clientMessageId },
      mode: 'preview',
    })
    assert.equal(preview.strategy, 'native')
    assert.deepEqual(preview.available, { native: true, fork: false })
    assert.equal(preview.fileDiff.length, 1)
    assert.equal(preview.fileDiff[0]?.file, 'README.md')
    const diffRequest = await waitForRequest(harness, (r) => r.method === 'GET' && r.path.endsWith('/diff'))
    assert.ok(diffRequest.search.includes(`messageID=msg_${clientMessageId}`))

    const applied = await harness.adapter.rewindSession({
      sessionId,
      projectPath: harness.directory,
      target: { by: 'message', messageUuid: 'input-1', clientMessageId },
      mode: 'apply',
    })
    assert.equal(applied.filesReverted, true)
    const revertRequest = await waitForRequest(
      harness,
      (r) => r.method === 'POST' && r.path.endsWith('/revert'),
    )
    assert.deepEqual(revertRequest.body, { messageID: `msg_${clientMessageId}` })
  } finally {
    await harness.close()
  }
})

test('throws when an OpenCode rewind target has no clientMessageId', async () => {
  const harness = await createV2Harness()
  const sessionId = asSessionId('gateway-v2-rewind-unresolved')
  try {
    await harness.adapter.createSession({
      sessionId,
      projectPath: harness.directory,
      connection: harness.connection,
    })
    await waitForRequest(harness, (r) => r.method === 'POST' && r.path === expectedV2Paths.create)
    await assert.rejects(
      harness.adapter.rewindSession({
        sessionId,
        projectPath: harness.directory,
        target: { by: 'message', messageUuid: 'input-1' },
        mode: 'preview',
      }),
      /cannot resolve rewind target/,
    )
  } finally {
    await harness.close()
  }
})

async function resumeAndCollect(
  predicate: (events: AdapterEvent[]) => boolean,
): Promise<{ harness: Awaited<ReturnType<typeof createV2Harness>>; events: AdapterEvent[] }> {
  const harness = await createV2Harness()
  const sessionId = asSessionId(`gateway-v2-events-${Math.random()}`)
  try {
    await harness.adapter.resumeSession({
      sessionId,
      projectPath: harness.directory,
      runtimeSessionId: existingSessionId,
      connection: harness.connection,
      cursor: { by: 'sequence', sequence: 7 },
    })
    const events = await collectUntil(harness.adapter.events(sessionId), predicate)
    return { harness, events }
  } catch (error) {
    await harness.close()
    throw error
  }
}

function assertEventTypes(events: AdapterEvent[], expected: AdapterEvent['type'][]): void {
  const actual = new Set(events.map((event) => event.type))
  for (const type of expected) assert.ok(actual.has(type), `missing mapped event ${type}`)
}
