import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  inputAdmissionReceiptSchema,
  sendSessionInputRequestSchema,
  sessionEventsQuerySchema,
  sessionListResponseSchema,
  sessionSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type GatewaySession,
  type InputAdmissionReceipt,
  type SendSessionInputRequest
} from '@agent-gateway/shared'
import { z } from 'zod'
import { errorResponseSchema, idSchema } from '../../http/schemas.js'

export {
  createSessionRequestSchema as createSessionBodySchema,
  createSessionResponseSchema,
  inputAdmissionReceiptSchema,
  sendSessionInputRequestSchema,
  sessionEventsQuerySchema,
  sessionListResponseSchema,
  sessionSchema
}

export const projectSessionsParamsSchema = z.strictObject({ projectId: idSchema })
export const sessionParamsSchema = z.strictObject({ sessionId: idSchema })

export const sessionErrorResponses = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
  502: errorResponseSchema
}

export type CreateSessionBody = CreateSessionRequest
export type CreateSessionResult = CreateSessionResponse
export type SessionResponse = GatewaySession
export type SendSessionInputBody = SendSessionInputRequest
export type SendSessionInputResult = InputAdmissionReceipt
