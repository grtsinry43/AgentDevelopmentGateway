import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { SERVER_CAPABILITIES, SERVER_PROTOCOL_VERSION, SERVER_VERSION } from '../../protocol.js'
import type { ServerIdentity } from './repository.js'
import { serverInfoSchema, serverStatusSchema } from './schemas.js'
import { serverStatusSnapshot } from './status.js'

interface ServerRoutesOptions {
  identity: ServerIdentity
}

export const serverRoutes: FastifyPluginAsyncZod<ServerRoutesOptions> = async (
  server,
  options
) => {
  server.get(
    '/server',
    { schema: { response: { 200: serverInfoSchema } } },
    async () => ({
      serverId: options.identity.id,
      hostId: options.identity.id,
      version: SERVER_VERSION,
      protocolVersion: SERVER_PROTOCOL_VERSION,
      capabilities: [...SERVER_CAPABILITIES],
      createdAt: options.identity.createdAt
    })
  )

  server.get(
    '/server/status',
    { schema: { response: { 200: serverStatusSchema } } },
    async () => serverStatusSnapshot(options.identity.id)
  )
}
