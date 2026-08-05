import {
  workspaceDirectoryQuerySchema,
  workspaceDirectoryResponseSchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentResponseSchema,
  workspaceFileCreateRequestSchema,
  workspaceFileMoveRequestSchema,
  workspaceFileSubscriptionParamsSchema,
  workspaceFileSubscriptionSchema,
  workspaceFileWriteRequestSchema
} from '@agent-gateway/shared'
import { z } from 'zod'
import { errorResponseSchema, idParamsSchema } from '../../http/schemas.js'

export {
  workspaceDirectoryQuerySchema,
  workspaceDirectoryResponseSchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentResponseSchema,
  workspaceFileCreateRequestSchema,
  workspaceFileMoveRequestSchema,
  workspaceFileSubscriptionParamsSchema,
  workspaceFileSubscriptionSchema,
  workspaceFileWriteRequestSchema
}

export const workspaceFilesParamsSchema = z.strictObject({ projectId: idParamsSchema.shape.id })

export const workspaceFileErrorResponses = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema
}
