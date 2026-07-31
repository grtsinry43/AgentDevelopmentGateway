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

const runtimeCapabilitiesSchema = z.strictObject({
  steer: z.enum(['native', 'queue-fallback', 'unsupported']),
  modelSwitch: z.enum(['in-session', 'restart-session', 'unsupported']),
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
  text: z.string().trim().min(1),
  delivery: z.enum(['steer', 'queue']).optional(),
})

export const sessionSchema = z.strictObject({
  id: gatewayIdSchema,
  projectId: gatewayIdSchema,
  hostId: gatewayIdSchema,
  adapterId: adapterIdSchema,
  runtimeSessionId: z.string().optional(),
  providerProfileId: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  mode: z.enum(['default', 'plan']).optional(),
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
  mode: z.enum(['default', 'plan']).optional(),
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
