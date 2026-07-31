import {
  adapterAvailabilitySchema,
  adapterIdSchema,
  adaptersResponseSchema,
  createProjectRequestSchema,
  projectAvailabilitySchema,
  projectListResponseSchema,
  projectSchema,
  type GatewayProject
} from '@agent-gateway/shared'
import { z } from 'zod'
import { errorResponseSchema, idParamsSchema } from '../../http/schemas.js'

export {
  adapterAvailabilitySchema,
  adapterIdSchema,
  adaptersResponseSchema,
  createProjectRequestSchema as createProjectBodySchema,
  projectAvailabilitySchema,
  projectListResponseSchema,
  projectSchema
}

export const projectParamsSchema = idParamsSchema

export const projectErrorResponses = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema
}

export type CreateProjectBody = z.infer<typeof createProjectRequestSchema>
export type ProjectResponse = GatewayProject
