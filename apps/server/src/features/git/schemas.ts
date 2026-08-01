import {
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffQuerySchema,
  gitDiffResponseSchema,
  gitEventSchema,
  gitPathsRequestSchema,
  gitRepositoryStateSchema
} from '@agent-gateway/shared'
import { z } from 'zod'
import { errorResponseSchema, idParamsSchema } from '../../http/schemas.js'

export {
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffQuerySchema,
  gitDiffResponseSchema,
  gitEventSchema,
  gitPathsRequestSchema,
  gitRepositoryStateSchema
}

export const projectGitParamsSchema = z.strictObject({ projectId: idParamsSchema.shape.id })

export const gitErrorResponses = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema
}
