import cors from '@fastify/cors'
import { APP_NAME, type HealthResponse } from '@agent-gateway/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'

const healthResponseSchema: z.ZodType<HealthResponse> = z.object({
  service: z.literal(APP_NAME),
  status: z.literal('ok')
})

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true })

  server.register(cors, {
    methods: ['GET'],
    origin: ['null', /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/]
  })

  server.get<{ Reply: HealthResponse }>('/health', async () =>
    healthResponseSchema.parse({
      service: APP_NAME,
      status: 'ok'
    })
  )

  return server
}
