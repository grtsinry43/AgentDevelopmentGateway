import {
  adapterAvailabilitySchema,
  adapterIdSchema,
  adaptersResponseSchema,
  createProjectRequestSchema,
  listModelsQuerySchema,
  modelCatalogSchema,
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
  listModelsQuerySchema,
  modelCatalogSchema,
  projectAvailabilitySchema,
  projectListResponseSchema,
  projectSchema
}

export const projectParamsSchema = idParamsSchema
export const projectAgentParamsSchema = idParamsSchema.extend({ adapterId: adapterIdSchema })

export const projectErrorResponses = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
  502: errorResponseSchema
}

export type CreateProjectBody = z.infer<typeof createProjectRequestSchema>
export type ProjectResponse = GatewayProject
