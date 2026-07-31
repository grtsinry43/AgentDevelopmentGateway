import {
  gatewayErrorResponseSchema,
  gatewayIdSchema,
  gatewayTimestampSchema
} from '@agent-gateway/shared'
import { z } from 'zod'

export const idSchema = gatewayIdSchema
export const timestampSchema = gatewayTimestampSchema
export const errorResponseSchema = gatewayErrorResponseSchema

export const idParamsSchema = z.strictObject({ id: idSchema })
