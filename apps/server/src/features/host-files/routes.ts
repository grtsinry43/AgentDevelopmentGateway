import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { hostDirectoryResponseSchema } from '@agent-gateway/shared'
import { z } from 'zod'
import { HostFilesService } from './service.js'

const directoryQuerySchema = z.strictObject({
  path: z.string().min(1)
})

export const hostFilesRoutes: FastifyPluginAsyncZod = async (server) => {
  const files = new HostFilesService()
  server.get(
    '/host/files',
    {
      schema: {
        querystring: directoryQuerySchema,
        response: { 200: hostDirectoryResponseSchema }
      }
    },
    async (request) => {
      const path = request.query.path === '' ? '~' : request.query.path
      return files.list(path)
    }
  )
}
