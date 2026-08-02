import {
  workspaceDirectoryQuerySchema,
  workspaceDirectoryResponseSchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentResponseSchema,
  workspaceFileSubscriptionParamsSchema,
  workspaceFileSubscriptionSchema
} from '@agent-gateway/shared'
import { z } from 'zod'
import { errorResponseSchema, idParamsSchema } from '../../http/schemas.js'

export {
  workspaceDirectoryQuerySchema,
  workspaceDirectoryResponseSchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentResponseSchema,
  workspaceFileSubscriptionParamsSchema,
  workspaceFileSubscriptionSchema
}

export const workspaceFilesParamsSchema = z.strictObject({ projectId: idParamsSchema.shape.id })

export const workspaceFileErrorResponses = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema
}
