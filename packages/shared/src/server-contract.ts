import { z } from 'zod'

export const gatewayIdSchema = z.string().uuid()
export const gatewayTimestampSchema = z.number().int().nonnegative()
export const adapterIdSchema = z.enum(['claude-code', 'codex', 'opencode'])

export const gatewayErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }),
})

export const serverInfoSchema = z.strictObject({
  serverId: gatewayIdSchema,
  hostId: gatewayIdSchema,
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  capabilities: z.array(z.string()),
  createdAt: gatewayTimestampSchema,
})

/** 主机运行状态:资源占用与版本。远程连接状态面板的展示依据。 */
export const serverStatusSchema = z.strictObject({
  hostId: gatewayIdSchema,
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  hostname: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  cpus: z.number().int().positive(),
  loadAvg: z.tuple([z.number(), z.number(), z.number()]),
  memory: z.strictObject({
    totalBytes: z.number().nonnegative(),
    freeBytes: z.number().nonnegative(),
    usagePercent: z.number().min(0).max(100),
  }),
  gateway: z.strictObject({
    pid: z.number().int().positive(),
    rssBytes: z.number().nonnegative(),
  }),
  uptimeSeconds: z.number().nonnegative(),
})

export type ServerStatus = z.infer<typeof serverStatusSchema>

/** 主机文件系统目录浏览(新建远程工程时选工程根,不经 Project scope)。 */
export const hostDirectoryEntrySchema = z.strictObject({
  name: z.string().min(1),
  type: z.enum(['dir', 'file', 'other']),
  symlink: z.boolean(),
})
export const hostDirectoryResponseSchema = z.strictObject({
  path: z.string().min(1),
  parent: z.string().nullable(),
  entries: z.array(hostDirectoryEntrySchema),
})
export type HostDirectoryResponse = z.infer<typeof hostDirectoryResponseSchema>

export const projectAvailabilitySchema = z.enum(['available', 'missing', 'unreachable'])
export const projectSchema = z.strictObject({
  id: gatewayIdSchema,
  name: z.string().min(1),
  hostId: gatewayIdSchema,
  path: z.string().min(1),
  availability: projectAvailabilitySchema,
  createdAt: gatewayTimestampSchema,
  updatedAt: gatewayTimestampSchema,
})
export const createProjectRequestSchema = z.strictObject({
  path: z.string().min(1),
  name: z.string().trim().min(1).optional(),
})
export const projectListResponseSchema = z.strictObject({ projects: z.array(projectSchema) })

export const workspaceRelativePathSchema = z.string().max(16_384)
export const gitPathSchema = workspaceRelativePathSchema.refine((path) => path.length > 0, {
  message: 'Git path cannot be empty',
})
export const workspaceFileKindSchema = z.enum(['file', 'directory', 'symlink'])
export const workspaceFileNodeSchema = z.strictObject({
  name: z.string().min(1),
  path: workspaceRelativePathSchema,
  kind: workspaceFileKindSchema,
  generated: z.boolean(),
})
export const workspaceDirectoryQuerySchema = z.strictObject({
  path: workspaceRelativePathSchema.default(''),
})
export const workspaceDirectoryResponseSchema = z.strictObject({
  path: workspaceRelativePathSchema,
  entries: z.array(workspaceFileNodeSchema),
})
export const workspaceFileContentQuerySchema = z.strictObject({
  path: workspaceRelativePathSchema.refine((path) => path.length > 0, {
    message: 'Workspace file path cannot be empty',
  }),
})
export const workspaceFileContentResponseSchema = z.strictObject({
  path: workspaceRelativePathSchema,
  content: z.string(),
  size: z.number().int().nonnegative(),
})
export const workspaceFileSubscriptionParamsSchema = z.strictObject({
  projectId: gatewayIdSchema,
  subscriptionId: gatewayIdSchema,
})
export const workspaceFileSubscriptionSchema = z.strictObject({
  directories: z.array(workspaceRelativePathSchema).max(2_048),
})
export const workspaceFileEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('workspace.files.resync'),
    projectId: gatewayIdSchema,
    subscriptionId: gatewayIdSchema,
    timestamp: gatewayTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('workspace.files.invalidated'),
    projectId: gatewayIdSchema,
    subscriptionId: gatewayIdSchema,
    paths: z.array(workspaceRelativePathSchema).min(1),
    timestamp: gatewayTimestampSchema,
  }),
])

export const gitChangeAreaSchema = z.enum(['conflict', 'staged', 'unstaged', 'untracked'])
export const gitFileStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'unmerged',
  'untracked',
])
export const gitChangeSchema = z.strictObject({
  path: gitPathSchema,
  previousPath: gitPathSchema.optional(),
  area: gitChangeAreaSchema,
  status: gitFileStatusSchema,
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
})
export const gitBranchSchema = z.strictObject({
  name: z.string().min(1).optional(),
  detached: z.boolean(),
  oid: z.string().min(1).optional(),
  upstream: z.string().min(1).optional(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
})
export const gitRepositoryStateSchema = z.strictObject({
  branch: gitBranchSchema,
  changes: z.array(gitChangeSchema),
  updatedAt: gatewayTimestampSchema,
})
export const gitPathsRequestSchema = z.strictObject({
  paths: z.array(gitPathSchema).min(1).max(10_000),
})
export const gitDiffQuerySchema = z.strictObject({
  path: gitPathSchema,
  area: gitChangeAreaSchema,
})
export const gitCommitRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(100_000),
})
export const gitCommitResponseSchema = z.strictObject({
  oid: z.string().min(1),
  summary: z.string(),
})
export const gitEventSchema = z.strictObject({
  type: z.literal('workspace.git.changed'),
  projectId: gatewayIdSchema,
  timestamp: gatewayTimestampSchema,
})

export const terminalStatusSchema = z.enum(['running', 'exited'])
export const terminalDescriptorSchema = z.strictObject({
  id: gatewayIdSchema,
  projectId: gatewayIdSchema,
  title: z.string().min(1),
  shell: z.string().min(1),
  cwd: z.string().min(1),
  status: terminalStatusSchema,
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
  exitCode: z.number().int().nullable().optional(),
  signal: z.number().int().nullable().optional(),
  createdAt: gatewayTimestampSchema,
  updatedAt: gatewayTimestampSchema,
})
export const terminalListResponseSchema = z.strictObject({
  terminals: z.array(terminalDescriptorSchema),
})
export const createTerminalRequestSchema = z.strictObject({
  cols: z.number().int().min(2).max(500).default(80),
  rows: z.number().int().min(1).max(300).default(24),
})
export const projectTerminalParamsSchema = z.strictObject({ projectId: gatewayIdSchema })
export const terminalParamsSchema = z.strictObject({ terminalId: gatewayIdSchema })
export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('terminal.attach'),
    afterSequence: z.number().int().nonnegative().optional(),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(300),
  }),
  z.strictObject({
    type: z.literal('terminal.input'),
    data: z.string().min(1).max(1_048_576),
  }),
  z.strictObject({
    type: z.literal('terminal.resize'),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(300),
  }),
  z.strictObject({
    type: z.literal('terminal.ack'),
    sequence: z.number().int().nonnegative(),
  }),
])
export const terminalServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('terminal.ready'),
    terminal: terminalDescriptorSchema,
    sequence: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('terminal.snapshot'),
    terminal: terminalDescriptorSchema,
    sequence: z.number().int().nonnegative(),
    data: z.string(),
  }),
  z.strictObject({
    type: z.literal('terminal.output'),
    sequence: z.number().int().positive(),
    data: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('terminal.exit'),
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
  }),
  z.strictObject({
    type: z.literal('terminal.error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
])

export const runtimeCapabilitiesSchema = z.strictObject({
  steer: z.enum(['native', 'queue-fallback', 'unsupported']),
  modelSwitch: z.enum(['in-session', 'restart-session', 'unsupported']),
  execution: z.strictObject({
    workModes: z.array(z.enum(['build', 'plan'])),
    approvalActions: z.array(z.enum(['allow', 'ask', 'deny'])),
    approvalReviewers: z.array(z.enum(['user', 'provider'])),
    filesystemSandbox: z.array(z.enum(['read-only', 'workspace-write', 'unrestricted'])),
    networkAccess: z.array(z.enum(['deny', 'ask', 'allow'])),
    update: z.enum(['in-session', 'create-only', 'unsupported']),
    granularRules: z.boolean(),
  }),
  features: z.record(z.string(), z.boolean()),
  raw: z.array(z.string()),
  degradations: z
    .array(
      z.strictObject({
        capability: z.string(),
        status: z.enum(['unsupported', 'partial', 'experimental']),
        reason: z.string(),
      }),
    )
    .optional(),
})

export const runtimeErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  layer: z.string().optional(),
  severity: z.string().optional(),
  retriable: z.boolean().optional(),
  retryAfterMs: z.number().optional(),
  nativeCode: z.string().optional(),
  details: z.unknown().optional(),
})

export const adapterAvailabilitySchema = z.strictObject({
  adapterId: adapterIdSchema,
  descriptor: z.strictObject({
    id: adapterIdSchema,
    displayName: z.string(),
    adapterVersion: z.string(),
    runtimeVersion: z.string().optional(),
    protocolVersion: z.string(),
    capabilities: runtimeCapabilitiesSchema,
  }),
  status: z.enum(['available', 'unavailable']),
  installations: z.array(
    z.strictObject({
      path: z.string(),
      version: z.string().optional(),
      source: z.enum(['path', 'npm', 'managed', 'custom']),
    }),
  ),
  error: runtimeErrorSchema.optional(),
})
export const adaptersResponseSchema = z.strictObject({
  adapters: z.array(adapterAvailabilitySchema),
})
export const modelReasoningEffortSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
})
export const runtimeModelSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
  reasoningEfforts: z.array(modelReasoningEffortSchema),
})
export const modelCatalogSchema = z.strictObject({
  models: z.array(runtimeModelSchema),
})
export const listModelsQuerySchema = z.strictObject({
  installationPath: z.string().min(1).optional(),
})

export const sessionStatusSchema = z.enum([
  'starting',
  'idle',
  'running',
  'waiting',
  'interrupted',
  'error',
  'closed',
])

export const userTextInputSchema = z.strictObject({
  clientMessageId: gatewayIdSchema,
  text: z.string().trim().min(1),
  delivery: z.enum(['steer', 'queue']).optional(),
})

export const inputQueueEntrySchema = z.strictObject({
  id: gatewayIdSchema,
  input: userTextInputSchema,
  requestedDelivery: z.enum(['steer', 'queue']),
  effectiveDelivery: z.enum(['steer', 'queue']).optional(),
  status: z.enum(['pending', 'delivered', 'failed', 'cancelled']),
  admittedSequence: z.number().int().positive(),
  position: z.number().int().nonnegative().optional(),
  turnId: gatewayIdSchema.optional(),
  error: runtimeErrorSchema.optional(),
  createdAt: gatewayTimestampSchema,
  updatedAt: gatewayTimestampSchema,
})

export const subagentRunSchema = z.strictObject({
  id: gatewayIdSchema,
  sessionId: gatewayIdSchema,
  parentSubagentRunId: gatewayIdSchema.optional(),
  parentToolCallId: z.string().min(1).optional(),
  runtimeSubagentId: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z
    .strictObject({
      model: z.string().min(1),
      reasoningEffort: z.string().min(1).optional(),
    })
    .optional(),
  executionMode: z.enum(['foreground', 'background']),
  status: z.enum([
    'starting',
    'running',
    'waiting',
    'completed',
    'failed',
    'interrupted',
    'cancelled',
  ]),
  resultSummary: z.string().optional(),
  error: runtimeErrorSchema.optional(),
  startedAt: gatewayTimestampSchema,
  updatedAt: gatewayTimestampSchema,
  completedAt: gatewayTimestampSchema.optional(),
})

export const permissionRuleSchema = z.strictObject({
  id: z.string().min(1),
  action: z.enum(['allow', 'ask', 'deny']),
  toolKind: z
    .enum(['read', 'write', 'execute', 'search', 'network', 'mcp', 'question', 'other'])
    .optional(),
  tool: z.string().min(1).optional(),
  resource: z
    .strictObject({
      kind: z.enum(['path', 'command', 'url', 'mcp']),
      pattern: z.string().min(1),
    })
    .optional(),
})

export const sessionExecutionSettingsSchema = z.strictObject({
  workMode: z.enum(['build', 'plan']),
  approval: z.strictObject({
    defaultAction: z.enum(['allow', 'ask', 'deny']),
    reviewer: z.enum(['user', 'provider']),
    rules: z.array(permissionRuleSchema),
  }),
  sandbox: z.strictObject({
    filesystem: z.enum(['read-only', 'workspace-write', 'unrestricted']),
    network: z.enum(['deny', 'ask', 'allow']),
  }),
})

export const sessionExecutionStateSchema = z.strictObject({
  configured: sessionExecutionSettingsSchema,
  effective: sessionExecutionSettingsSchema,
  limitations: z.array(
    z.strictObject({
      capability: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
})

export const diffLineSchema = z.strictObject({
  kind: z.enum(['context', 'addition', 'deletion', 'no-newline']),
  text: z.string(),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
})

export const diffHunkSchema = z.strictObject({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  heading: z.string().optional(),
  lines: z.array(diffLineSchema),
})

export const fileChangeSchema = z.strictObject({
  path: z.string().min(1),
  pathKind: z.enum(['workspace-relative', 'absolute']),
  kind: z.enum(['create', 'modify', 'delete', 'rename']),
  previousPath: z.string().min(1).optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
  hunks: z.array(diffHunkSchema),
  binary: z.boolean().optional(),
  truncation: z
    .strictObject({
      reason: z.enum(['line_limit', 'byte_limit', 'provider']),
      omittedLines: z.number().int().nonnegative().optional(),
    })
    .optional(),
})

export const gitDiffResponseSchema = z.strictObject({ change: fileChangeSchema })

export const changeSetSchema = z.strictObject({
  id: z.string().min(1),
  intent: z.enum(['proposed', 'applied']),
  scope: z.enum(['tool', 'turn', 'session']),
  status: z.enum(['running', 'completed', 'declined', 'error']),
  toolCallId: z.string().min(1).optional(),
  files: z.array(fileChangeSchema),
})

export const toolPresentationSchema = z.strictObject({
  target: z
    .strictObject({
      kind: z.enum(['path', 'command', 'query', 'url', 'task', 'resource']),
      value: z.string().min(1),
    })
    .optional(),
  resultText: z.string().optional(),
  resultSummary: z.string().optional(),
})

export const changesUpdatedPayloadSchema = z.strictObject({ changeSet: changeSetSchema })

export const taskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
export const taskPrioritySchema = z.enum(['high', 'medium', 'low'])
export const taskItemSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  status: taskStatusSchema,
  description: z.string().optional(),
  activeText: z.string().optional(),
  priority: taskPrioritySchema.optional(),
  owner: z.string().optional(),
  blocks: z.array(z.string().min(1)).optional(),
  blockedBy: z.array(z.string().min(1)).optional(),
})
export const taskStateSchema = z.strictObject({
  tasks: z.array(taskItemSchema),
  explanation: z.string().optional(),
})
const taskItemPatchSchema = taskItemSchema
  .pick({
    title: true,
    status: true,
    description: true,
    activeText: true,
    priority: true,
    owner: true,
  })
  .partial()
const taskRelationsAppendSchema = z.strictObject({
  blocks: z.array(z.string().min(1)).optional(),
  blockedBy: z.array(z.string().min(1)).optional(),
})
export const taskStateUpdateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('replace'),
    tasks: z.array(taskItemSchema),
    explanation: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('upsert'), task: taskItemSchema }),
  z.strictObject({
    kind: z.literal('patch'),
    id: z.string().min(1),
    changes: taskItemPatchSchema,
    append: taskRelationsAppendSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('remove'), id: z.string().min(1) }),
])
export const taskUpdatedPayloadSchema = z.strictObject({ update: taskStateUpdateSchema })

const interactionBaseSchema = z.strictObject({
  id: gatewayIdSchema,
  sessionId: gatewayIdSchema,
  turnId: gatewayIdSchema.optional(),
  toolCallId: z.string().min(1).optional(),
  createdAt: gatewayTimestampSchema,
})

export const interactionRequestSchema = z.discriminatedUnion('kind', [
  interactionBaseSchema.extend({
    kind: z.literal('tool_permission'),
    toolKind: z.enum([
      'terminal',
      'file-read',
      'file-edit',
      'file-diff',
      'notebook-edit',
      'search',
      'web',
      'subagent',
      'task-control',
      'todo',
      'plan',
      'mcp',
      'worktree',
      'generic',
    ]),
    toolName: z.string().min(1),
    input: z.unknown().optional(),
    proposedChangeSet: changeSetSchema.optional(),
    prompt: z.string(),
    resources: z.array(z.string()).optional(),
    availableDecisions: z.array(z.string()).optional(),
    suggestions: z.unknown().optional(),
  }),
  interactionBaseSchema.extend({
    kind: z.literal('question'),
    questions: z.array(
      z.strictObject({
        id: z.string().min(1),
        header: z.string().optional(),
        question: z.string(),
        options: z
          .array(
            z.strictObject({
              id: z.string().min(1),
              label: z.string(),
              description: z.string().optional(),
              preview: z.string().optional(),
            }),
          )
          .optional(),
        multiSelect: z.boolean().optional(),
        allowCustom: z.boolean().optional(),
        isSecret: z.boolean().optional(),
      }),
    ),
  }),
  interactionBaseSchema.extend({
    kind: z.literal('permission_grant'),
    prompt: z.string(),
    requestedProfile: z.unknown(),
  }),
  interactionBaseSchema.extend({
    kind: z.literal('host_dialog'),
    dialogKind: z.string(),
    payload: z.unknown(),
  }),
  interactionBaseSchema.extend({
    kind: z.literal('elicitation'),
    serverName: z.string(),
    message: z.string(),
    mode: z.enum(['form', 'url']),
    requestedSchema: z.unknown().optional(),
  }),
])

const permissionScopeSchema = z.enum(['once', 'turn', 'session'])
export const interactionResolutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tool_permission'),
    id: gatewayIdSchema,
    decision: z.union([
      z.strictObject({
        behavior: z.literal('allow'),
        updatedInput: z.unknown().optional(),
        scope: permissionScopeSchema.optional(),
      }),
      z.strictObject({
        behavior: z.literal('deny'),
        message: z.string().optional(),
        abortTurn: z.boolean().optional(),
      }),
    ]),
    persistRule: z
      .strictObject({
        rule: z.strictObject({ toolName: z.string(), ruleContent: z.string().optional() }),
        destination: z.enum(['session', 'project', 'user', 'local']),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('question'),
    id: gatewayIdSchema,
    answers: z.record(z.string(), z.array(z.string())),
  }),
  z.strictObject({ kind: z.literal('question_rejected'), id: gatewayIdSchema }),
  z.strictObject({
    kind: z.literal('permission_grant'),
    id: gatewayIdSchema,
    grantedProfile: z.unknown(),
    scope: permissionScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('host_dialog'),
    id: gatewayIdSchema,
    outcome: z.union([
      z.strictObject({ behavior: z.literal('completed'), result: z.unknown() }),
      z.strictObject({ behavior: z.literal('cancelled') }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('elicitation'),
    id: gatewayIdSchema,
    outcome: z.union([
      z.strictObject({ behavior: z.literal('completed'), content: z.unknown() }),
      z.strictObject({ behavior: z.literal('cancelled') }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('canceled'),
    id: gatewayIdSchema,
    reason: z.enum(['timed_out', 'aborted', 'superseded']),
  }),
])

export const sessionSchema = z.strictObject({
  id: gatewayIdSchema,
  projectId: gatewayIdSchema,
  hostId: gatewayIdSchema,
  adapterId: adapterIdSchema,
  runtimeSessionId: z.string().optional(),
  providerProfileId: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  execution: sessionExecutionStateSchema,
  controlRevision: z.number().int().nonnegative(),
  capabilities: runtimeCapabilitiesSchema,
  pendingInteractions: z.array(interactionRequestSchema),
  taskState: taskStateSchema,
  subagentRuns: z.array(subagentRunSchema),
  inputQueue: z.array(inputQueueEntrySchema),
  status: sessionStatusSchema,
  title: z.string().optional(),
  lastEventSequence: z.number().int().nonnegative(),
  createdAt: gatewayTimestampSchema,
  updatedAt: gatewayTimestampSchema,
})

export const createSessionRequestSchema = z.strictObject({
  adapterId: adapterIdSchema,
  installationPath: z.string().min(1).optional(),
  providerProfileId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  execution: sessionExecutionSettingsSchema.optional(),
  initialInput: userTextInputSchema,
})

export const sendSessionInputRequestSchema = z.strictObject({
  input: userTextInputSchema,
})

export const inputAdmissionReceiptSchema = z.strictObject({
  admittedSequence: z.number().int().positive(),
  turnId: gatewayIdSchema.optional(),
})

export const replaceQueuedInputRequestSchema = z.strictObject({ input: userTextInputSchema })
export const reorderQueuedInputsRequestSchema = z.strictObject({
  inputIds: z.array(gatewayIdSchema),
})

export const createSessionResponseSchema = z.strictObject({
  session: sessionSchema,
  receipt: inputAdmissionReceiptSchema,
})

export const sessionListResponseSchema = z.strictObject({ sessions: z.array(sessionSchema) })
export const sessionEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().default(0),
})

export const controlOptionsSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().optional(),
})
export const controlReceiptSchema = z.strictObject({
  controlRevision: z.number().int().nonnegative(),
})
export const interruptSessionRequestSchema = z.strictObject({
  turnId: gatewayIdSchema.optional(),
  expectedTurnId: gatewayIdSchema.optional(),
  cancelQueued: z.boolean().optional(),
})
export const resolveInteractionRequestSchema = z.strictObject({
  resolution: interactionResolutionSchema,
})
export const setSessionTitleRequestSchema = controlOptionsSchema.extend({
  title: z.string().trim().min(1).max(200),
})
export const setSessionModelRequestSchema = controlOptionsSchema.extend({
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
})
export const setWorkModeRequestSchema = controlOptionsSchema.extend({
  workMode: z.enum(['build', 'plan']),
})
export const setExecutionSettingsRequestSchema = controlOptionsSchema.extend({
  execution: sessionExecutionSettingsSchema,
})
export const closeSessionRequestSchema = controlOptionsSchema
export const resumeSessionRequestSchema = z.strictObject({
  installationPath: z.string().min(1).optional(),
})
const resumeCursorSchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('sequence'), sequence: z.number().int().nonnegative() }),
  z.strictObject({ by: z.literal('message'), messageUuid: z.string().min(1) }),
  z.strictObject({ by: z.literal('rollout-path'), path: z.string().min(1) }),
  z.strictObject({ by: z.literal('snapshot'), providerStateSnapshot: z.string() }),
])
export const forkSessionRequestSchema = z.strictObject({
  forkPoint: resumeCursorSchema.optional(),
  execution: sessionExecutionSettingsSchema.optional(),
})

/**
 * Runtime payloads stay provider-neutral and versioned in core. The wire boundary validates
 * routing fields while deliberately preserving unknown payloads and extension events.
 */
export const runtimeEventWireSchema = z.strictObject({
  id: z.number().int().positive(),
  sequence: z.number().int().positive(),
  sessionId: gatewayIdSchema,
  adapterId: adapterIdSchema,
  timestamp: gatewayTimestampSchema,
  type: z.string().min(1),
  payload: z.unknown(),
  turnId: gatewayIdSchema.optional(),
  attribution: z.unknown().optional(),
  schemaVersion: z.number().int().positive().optional(),
  nativeRef: z.unknown().optional(),
})

export type GatewayAdapterId = z.infer<typeof adapterIdSchema>
export type GatewayErrorResponse = z.infer<typeof gatewayErrorResponseSchema>
export type GatewayServerInfo = z.infer<typeof serverInfoSchema>
export type GatewayProject = z.infer<typeof projectSchema>
export type WorkspaceFileKind = z.infer<typeof workspaceFileKindSchema>
export type WorkspaceFileNode = z.infer<typeof workspaceFileNodeSchema>
export type WorkspaceDirectoryResponse = z.infer<typeof workspaceDirectoryResponseSchema>
export type WorkspaceFileContentResponse = z.infer<typeof workspaceFileContentResponseSchema>
export type WorkspaceFileSubscription = z.infer<typeof workspaceFileSubscriptionSchema>
export type WorkspaceFileEvent = z.infer<typeof workspaceFileEventSchema>
export type GitChangeArea = z.infer<typeof gitChangeAreaSchema>
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>
export type GitChange = z.infer<typeof gitChangeSchema>
export type GitBranch = z.infer<typeof gitBranchSchema>
export type GitRepositoryState = z.infer<typeof gitRepositoryStateSchema>
export type GitPathsRequest = z.infer<typeof gitPathsRequestSchema>
export type GitDiffResponse = z.infer<typeof gitDiffResponseSchema>
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>
export type GitCommitResponse = z.infer<typeof gitCommitResponseSchema>
export type GitEvent = z.infer<typeof gitEventSchema>
export type TerminalStatus = z.infer<typeof terminalStatusSchema>
export type TerminalDescriptor = z.infer<typeof terminalDescriptorSchema>
export type TerminalListResponse = z.infer<typeof terminalListResponseSchema>
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>
export type GatewayAdapterAvailability = z.infer<typeof adapterAvailabilitySchema>
export type GatewayModelCatalog = z.infer<typeof modelCatalogSchema>
export type GatewayRuntimeModel = z.infer<typeof runtimeModelSchema>
export type ListModelsQuery = z.infer<typeof listModelsQuerySchema>
export type GatewaySession = z.infer<typeof sessionSchema>
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>
export type SendSessionInputRequest = z.infer<typeof sendSessionInputRequestSchema>
export type InputAdmissionReceipt = z.infer<typeof inputAdmissionReceiptSchema>
export type InputQueueEntryWire = z.infer<typeof inputQueueEntrySchema>
export type SubagentRunWire = z.infer<typeof subagentRunSchema>
export type ReplaceQueuedInputRequest = z.infer<typeof replaceQueuedInputRequestSchema>
export type ReorderQueuedInputsRequest = z.infer<typeof reorderQueuedInputsRequestSchema>
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>
export type RuntimeEventWire = z.infer<typeof runtimeEventWireSchema>
export type ChangeSetWire = z.infer<typeof changeSetSchema>
export type SessionExecutionSettingsWire = z.infer<typeof sessionExecutionSettingsSchema>
export type InteractionResolutionWire = z.infer<typeof interactionResolutionSchema>
export type RuntimeControlReceipt = z.infer<typeof controlReceiptSchema>
export type InterruptSessionRequest = z.infer<typeof interruptSessionRequestSchema>
export type ResolveInteractionRequest = z.infer<typeof resolveInteractionRequestSchema>
export type SetSessionTitleRequest = z.infer<typeof setSessionTitleRequestSchema>
export type SetSessionModelRequest = z.infer<typeof setSessionModelRequestSchema>
export type SetWorkModeRequest = z.infer<typeof setWorkModeRequestSchema>
export type SetExecutionSettingsRequest = z.infer<typeof setExecutionSettingsRequestSchema>
export type CloseSessionRequest = z.infer<typeof closeSessionRequestSchema>
export type ResumeSessionRequest = z.infer<typeof resumeSessionRequestSchema>
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>
