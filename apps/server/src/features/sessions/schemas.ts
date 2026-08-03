import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  closeSessionRequestSchema,
  controlReceiptSchema,
  forkSessionRequestSchema,
  inputAdmissionReceiptSchema,
  modelCatalogSchema,
  slashCommandsSchema,
  reorderQueuedInputsRequestSchema,
  replaceQueuedInputRequestSchema,
  interruptSessionRequestSchema,
  resolveInteractionRequestSchema,
  resumeSessionRequestSchema,
  sendSessionInputRequestSchema,
  setExecutionSettingsRequestSchema,
  setSessionModelRequestSchema,
  setSessionTitleRequestSchema,
  setWorkModeRequestSchema,
  sessionEventsQuerySchema,
  eventsHistoryQuerySchema,
  eventsHistoryResponseSchema,
  sessionItemsQuerySchema,
  sessionItemsResponseSchema,
  sessionListResponseSchema,
  sessionSchema,
  type EventsHistoryResponse,
  type SessionItemsResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type GatewaySession,
  type CloseSessionRequest,
  type ForkSessionRequest,
  type InputAdmissionReceipt,
  type ReorderQueuedInputsRequest,
  type ReplaceQueuedInputRequest,
  type InterruptSessionRequest,
  type ResolveInteractionRequest,
  type ResumeSessionRequest,
  type RuntimeControlReceipt,
  type SetExecutionSettingsRequest,
  type SetSessionModelRequest,
  type SetSessionTitleRequest,
  type SetWorkModeRequest,
  type SendSessionInputRequest
} from '@agent-gateway/shared'
import { z } from 'zod'
import { errorResponseSchema, idSchema } from '../../http/schemas.js'

export {
  createSessionRequestSchema as createSessionBodySchema,
  createSessionResponseSchema,
  closeSessionRequestSchema,
  controlReceiptSchema,
  forkSessionRequestSchema,
  inputAdmissionReceiptSchema,
  modelCatalogSchema,
  slashCommandsSchema,
  reorderQueuedInputsRequestSchema,
  replaceQueuedInputRequestSchema,
  interruptSessionRequestSchema,
  resolveInteractionRequestSchema,
  resumeSessionRequestSchema,
  sendSessionInputRequestSchema,
  setExecutionSettingsRequestSchema,
  setSessionModelRequestSchema,
  setSessionTitleRequestSchema,
  setWorkModeRequestSchema,
  sessionEventsQuerySchema,
  eventsHistoryQuerySchema,
  eventsHistoryResponseSchema,
  sessionItemsQuerySchema,
  sessionItemsResponseSchema,
  sessionListResponseSchema,
  sessionSchema,
  type EventsHistoryResponse,
  type SessionItemsResponse
}

export const projectSessionsParamsSchema = z.strictObject({ projectId: idSchema })
export const sessionParamsSchema = z.strictObject({ sessionId: idSchema })
export const sessionInteractionParamsSchema = z.strictObject({
  sessionId: idSchema,
  interactionId: idSchema
})
export const sessionInputParamsSchema = z.strictObject({
  sessionId: idSchema,
  inputId: idSchema
})

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
export type ReplaceQueuedInputBody = ReplaceQueuedInputRequest
export type ReorderQueuedInputsBody = ReorderQueuedInputsRequest
export type SessionControlResult = RuntimeControlReceipt
export type InterruptSessionBody = InterruptSessionRequest
export type ResolveInteractionBody = ResolveInteractionRequest
export type CloseSessionBody = CloseSessionRequest
export type ResumeSessionBody = ResumeSessionRequest
export type ForkSessionBody = ForkSessionRequest
export type SetSessionTitleBody = SetSessionTitleRequest
export type SetSessionModelBody = SetSessionModelRequest
export type SetWorkModeBody = SetWorkModeRequest
export type SetExecutionSettingsBody = SetExecutionSettingsRequest
