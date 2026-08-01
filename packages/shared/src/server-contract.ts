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

const runtimeErrorSchema = z.strictObject({
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
  turnId: gatewayIdSchema,
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
export type GatewayAdapterAvailability = z.infer<typeof adapterAvailabilitySchema>
export type GatewaySession = z.infer<typeof sessionSchema>
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>
export type SendSessionInputRequest = z.infer<typeof sendSessionInputRequestSchema>
export type InputAdmissionReceipt = z.infer<typeof inputAdmissionReceiptSchema>
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>
export type RuntimeEventWire = z.infer<typeof runtimeEventWireSchema>
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
