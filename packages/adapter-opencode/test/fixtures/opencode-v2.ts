export const projectPath = '/workspace/project'
export const nativeSessionId = 'ses_v2_contract'
export const existingSessionId = 'ses_v2_existing'
export const userMessageId = 'msg_user_contract'
export const assistantMessageId = 'msg_assistant_contract'

const model = { id: 'gpt-test', providerID: 'openai', variant: 'high' }
const timestamp = 1_754_000_000_000

export const sessionInfo = {
  id: nativeSessionId,
  projectID: 'project-contract',
  agent: 'build',
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: timestamp, updated: timestamp },
  title: 'V2 contract session',
  location: { directory: projectPath },
}

export const existingSessionInfo = { ...sessionInfo, id: existingSessionId }

export const admittedInput = {
  admittedSeq: 42,
  id: userMessageId,
  sessionID: nativeSessionId,
  prompt: { text: 'queued contract prompt' },
  delivery: 'queue',
  timeCreated: timestamp + 1,
}

export const modelCatalog = [{
  id: 'gpt-test',
  providerID: 'openai',
  family: 'gpt',
  name: 'GPT Test',
  api: { id: 'gpt-test', type: 'native', settings: {} },
  capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
  request: { headers: {}, body: {} },
  variants: [
    { id: 'low', headers: {}, body: { reasoningEffort: 'low' } },
    { id: 'high', headers: {}, body: { reasoningEffort: 'high' } },
  ],
  time: { released: timestamp },
  cost: [],
  status: 'active',
  enabled: true,
  limit: { context: 128_000, output: 16_384 },
}]

interface V2Event {
  id: string
  type: string
  durable?: { aggregateID: string; seq: number; version: number }
  data: Record<string, unknown>
}

let sequence = 8
const durable = (
  type: string,
  data: Record<string, unknown>,
  version = type === 'session.next.step.ended' || type === 'session.next.step.failed' ? 2 : 1,
): V2Event => ({
  id: `evt_contract_${sequence}`,
  type,
  durable: { aggregateID: existingSessionId, seq: sequence++, version },
  data: { timestamp: timestamp + sequence, sessionID: existingSessionId, ...data },
})

const live = (type: string, data: Record<string, unknown>): V2Event => ({
  id: `evt_contract_live_${sequence++}`,
  type,
  data: { timestamp: timestamp + sequence, sessionID: existingSessionId, ...data },
})

const ephemeral = (type: string, data: Record<string, unknown>): V2Event => ({
  id: `evt_contract_ephemeral_${sequence++}`,
  type,
  data,
})

export const globalEvents: V2Event[] = [
  // User message id is the SessionSummary.diff / summarize key (not assistantMessageID).
  durable('session.next.prompt.admitted', {
    messageID: userMessageId,
    id: userMessageId,
    prompt: { text: 'contract prompt' },
    delivery: 'queue',
  }),
  durable('session.next.step.started', {
    assistantMessageID: assistantMessageId,
    agent: 'build',
    model,
    snapshot: 'snapshot-before',
  }),
  durable('session.next.text.started', {
    assistantMessageID: assistantMessageId,
    textID: 'text-1',
  }),
  live('session.next.text.delta', {
    assistantMessageID: assistantMessageId,
    textID: 'text-1',
    delta: 'hello ',
  }),
  durable('session.next.text.ended', {
    assistantMessageID: assistantMessageId,
    textID: 'text-1',
    text: 'hello world',
  }),
  durable('session.next.reasoning.started', {
    assistantMessageID: assistantMessageId,
    reasoningID: 'reasoning-1',
    providerMetadata: { openai: { itemId: 'reasoning-native-1' } },
  }),
  live('session.next.reasoning.delta', {
    assistantMessageID: assistantMessageId,
    reasoningID: 'reasoning-1',
    delta: 'inspect ',
  }),
  durable('session.next.reasoning.ended', {
    assistantMessageID: assistantMessageId,
    reasoningID: 'reasoning-1',
    text: 'inspect result',
    providerMetadata: { openai: { itemId: 'reasoning-native-1' } },
  }),
  durable('session.next.tool.input.started', {
    assistantMessageID: assistantMessageId,
    callID: 'call-1',
    name: 'bash',
  }),
  live('session.next.tool.input.delta', {
    assistantMessageID: assistantMessageId,
    callID: 'call-1',
    delta: '{"command":"pwd"}',
  }),
  durable('session.next.tool.input.ended', {
    assistantMessageID: assistantMessageId,
    callID: 'call-1',
    text: '{"command":"pwd"}',
  }),
  durable('session.next.tool.called', {
    assistantMessageID: assistantMessageId,
    callID: 'call-1',
    tool: 'bash',
    input: { command: 'pwd' },
    provider: { executed: true },
  }),
  durable('session.next.tool.progress', {
    assistantMessageID: assistantMessageId,
    callID: 'call-1',
    structured: { phase: 'running' },
    content: [{ type: 'text', text: projectPath }],
  }),
  durable('session.next.tool.success', {
    assistantMessageID: assistantMessageId,
    callID: 'call-1',
    structured: { exitCode: 0 },
    content: [{ type: 'text', text: projectPath }],
    outputPaths: [],
    result: projectPath,
    provider: { executed: true },
  }),
  durable('session.next.tool.input.started', {
    assistantMessageID: assistantMessageId,
    callID: 'call-2',
    name: 'read',
  }),
  durable('session.next.tool.called', {
    assistantMessageID: assistantMessageId,
    callID: 'call-2',
    tool: 'read',
    input: { filePath: 'missing.txt' },
    provider: { executed: false },
  }),
  durable('session.next.tool.failed', {
    assistantMessageID: assistantMessageId,
    callID: 'call-2',
    error: { type: 'unknown', message: 'missing file' },
    result: { path: 'missing.txt' },
    provider: { executed: false },
  }),
  durable('session.next.retried', {
    attempt: 2,
    error: {
      message: 'rate limited',
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { 'retry-after': '1' },
    },
  }),
  durable('session.next.model.switched', {
    messageID: 'msg_model_switch_contract',
    model,
  }),
  durable('session.next.agent.switched', {
    messageID: 'msg_agent_switch_contract',
    agent: 'build',
  }),
  durable('session.next.shell.started', {
    messageID: 'msg_shell_contract',
    callID: 'shell-contract',
    command: 'pwd',
  }),
  durable('session.next.shell.ended', {
    callID: 'shell-contract',
    output: projectPath,
  }),
  durable('session.next.revert.cleared', {}),
  ephemeral('permission.v2.asked', {
    id: 'per_contract',
    sessionID: existingSessionId,
    action: 'bash',
    resources: ['pwd'],
    save: ['bash:*'],
    metadata: { command: 'pwd' },
    source: { type: 'tool', messageID: assistantMessageId, callID: 'call-1' },
  }),
  ephemeral('question.v2.asked', {
    id: 'que_contract',
    sessionID: existingSessionId,
    questions: [{
      header: 'Mode',
      question: 'Which mode should continue?',
      options: [
        { label: 'Fast', description: 'Continue immediately' },
        { label: 'Safe', description: 'Validate before continuing' },
      ],
      multiple: false,
      custom: true,
    }],
    tool: { messageID: assistantMessageId, callID: 'call-question' },
  }),
  durable('session.next.step.ended', {
    assistantMessageID: assistantMessageId,
    finish: 'stop',
    cost: 0.0125,
    tokens: { input: 120, output: 30, reasoning: 10, cache: { read: 40, write: 5 } },
    snapshot: 'snapshot-after',
    files: ['README.md'],
  }),
  durable('session.next.compaction.started', {
    messageID: 'msg_compaction_contract',
    reason: 'auto',
  }),
  live('session.next.compaction.delta', {
    messageID: 'msg_compaction_contract',
    text: 'summary fragment',
  }),
  durable('session.next.compaction.ended', {
    messageID: 'msg_compaction_contract',
    reason: 'auto',
    text: 'complete summary',
    recent: 'recent context',
  }),
  // todo.updated is live-only in OpenCode schema (no durable aggregate) — must not
  // be placed on the session replay log. Live delivery is covered by a dedicated test.
  durable('session.next.step.started', {
    assistantMessageID: 'msg_assistant_failed',
    agent: 'build',
    model,
  }),
  durable('session.next.step.failed', {
    assistantMessageID: 'msg_assistant_failed',
    error: { type: 'unknown', message: 'provider exploded' },
  }),
]

export const replayEvents = globalEvents.filter((event) => event.durable !== undefined)

/** Seed for GET /session/:id/todo — OpenCode's authoritative todo snapshot. */
export const existingSessionTodos = [
  { content: 'Map OpenCode todos', status: 'completed', priority: 'high' },
  { content: 'Wire Desktop projection', status: 'in_progress', priority: 'medium' },
  { content: 'Skip unsupported subagent events', status: 'pending', priority: 'low' },
] as const

/** Seed for GET /session/:id/diff — SnapshotFileDiff (`file`, not path). */
export const sessionDiffs = [
  {
    file: 'README.md',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1,0 +1,1 @@\n+hello\n',
  },
] as const

export const expectedV2Paths = {
  create: '/api/session',
  resume: `/api/session/${existingSessionId}`,
  prompt: `/api/session/${nativeSessionId}/prompt`,
  replay: `/api/session/${existingSessionId}/event?after=7`,
  wait: `/api/session/${nativeSessionId}/wait`,
  interrupt: `/session/${nativeSessionId}/abort`,
  model: `/api/session/${existingSessionId}/model`,
}
