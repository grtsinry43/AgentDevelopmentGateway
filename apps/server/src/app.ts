import { join } from 'node:path'
import { ClaudeAdapter } from '@agent-gateway/adapter-claude'
import { CodexAdapter } from '@agent-gateway/adapter-codex'
import { OpenCodeAdapter } from '@agent-gateway/adapter-opencode'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { APP_NAME, type HealthResponse } from '@agent-gateway/shared'
import type { RuntimeAdapter } from '@agent-gateway/core'
import Fastify, { type FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { installErrorHandler } from './http/errors.js'
import { errorResponseSchema } from './http/schemas.js'
import { applicationPlugin } from './plugins/application.js'
import type { TerminalPtyFactory } from './features/terminals/pty.js'

const healthResponseSchema: z.ZodType<HealthResponse> = z.object({
  service: z.literal(APP_NAME),
  status: z.literal('ok')
})

export interface BuildServerOptions {
  adapters?: RuntimeAdapter[]
  dataDirectory?: string
  databasePath?: string
  environment?: NodeJS.ProcessEnv
  logger?: boolean
  terminalPtyFactory?: TerminalPtyFactory
  terminalRetentionMs?: number
  terminalOutputBufferBytes?: number
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? true })
  server.setValidatorCompiler(validatorCompiler)
  server.setSerializerCompiler(serializerCompiler)
  installErrorHandler(server)

  server.register(websocket, {
    options: { maxPayload: 1_048_576, perMessageDeflate: false }
  })

  server.register(cors, {
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    origin: ['null', /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/]
  })

  server.get<{ Reply: HealthResponse }>(
    '/health',
    { schema: { response: { 200: healthResponseSchema, 500: errorResponseSchema } } },
    async () => ({ service: APP_NAME, status: 'ok' })
  )

  const dataDirectory = options.dataDirectory ?? join(process.cwd(), '.agent-gateway-server')
  server.register(applicationPlugin, {
    adapters: options.adapters ?? [new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter()],
    databasePath: options.databasePath ?? join(dataDirectory, 'gateway.sqlite'),
    environment: stringEnvironment(options.environment ?? process.env),
    ...(options.terminalPtyFactory ? { terminalPtyFactory: options.terminalPtyFactory } : {}),
    ...(options.terminalRetentionMs === undefined
      ? {}
      : { terminalRetentionMs: options.terminalRetentionMs }),
    ...(options.terminalOutputBufferBytes === undefined
      ? {}
      : { terminalOutputBufferBytes: options.terminalOutputBufferBytes })
  })

  return server
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}
