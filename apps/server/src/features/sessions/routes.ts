import { Readable } from 'node:stream'
import type { RuntimeEvent } from '@agent-gateway/core'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { SessionService } from './service.js'
import {
  createSessionBodySchema,
  createSessionResponseSchema,
  closeSessionRequestSchema,
  controlReceiptSchema,
  forkSessionRequestSchema,
  inputAdmissionReceiptSchema,
  interruptSessionRequestSchema,
  projectSessionsParamsSchema,
  reorderQueuedInputsRequestSchema,
  replaceQueuedInputRequestSchema,
  sendSessionInputRequestSchema,
  resolveInteractionRequestSchema,
  resumeSessionRequestSchema,
  setExecutionSettingsRequestSchema,
  setSessionModelRequestSchema,
  setSessionTitleRequestSchema,
  setWorkModeRequestSchema,
  sessionErrorResponses,
  sessionEventsQuerySchema,
  sessionListResponseSchema,
  sessionParamsSchema,
  sessionInteractionParamsSchema,
  sessionInputParamsSchema,
  sessionSchema
} from './schemas.js'

interface SessionRoutesOptions {
  sessions: SessionService
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000

export const sessionRoutes: FastifyPluginAsyncZod<SessionRoutesOptions> = async (
  server,
  options
) => {
  server.get(
    '/projects/:projectId/sessions',
    {
      schema: {
        params: projectSessionsParamsSchema,
        response: { 200: sessionListResponseSchema, ...sessionErrorResponses }
      }
    },
    async (request) => ({ sessions: options.sessions.list(request.params.projectId) })
  )

  server.post(
    '/projects/:projectId/sessions',
    {
      schema: {
        params: projectSessionsParamsSchema,
        body: createSessionBodySchema,
        response: { 201: createSessionResponseSchema, ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      const result = await options.sessions.create(request.params.projectId, request.body)
      return reply.code(201).send(result)
    }
  )

  server.post(
    '/sessions/:sessionId/interrupt',
    {
      schema: {
        params: sessionParamsSchema,
        body: interruptSessionRequestSchema,
        response: { ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      await options.sessions.interrupt(request.params.sessionId, request.body)
      reply.code(204)
    }
  )

  server.post(
    '/sessions/:sessionId/interactions/:interactionId/resolve',
    {
      schema: {
        params: sessionInteractionParamsSchema,
        body: resolveInteractionRequestSchema,
        response: { ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      await options.sessions.resolveInteraction(
        request.params.sessionId,
        request.params.interactionId,
        request.body
      )
      reply.code(204)
    }
  )

  server.post(
    '/sessions/:sessionId/close',
    {
      schema: {
        params: sessionParamsSchema,
        body: closeSessionRequestSchema,
        response: { 200: controlReceiptSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.close(request.params.sessionId, request.body)
  )

  server.post(
    '/sessions/:sessionId/resume',
    {
      schema: {
        params: sessionParamsSchema,
        body: resumeSessionRequestSchema,
        response: { 200: sessionSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.resume(request.params.sessionId, request.body)
  )

  server.post(
    '/sessions/:sessionId/forks',
    {
      schema: {
        params: sessionParamsSchema,
        body: forkSessionRequestSchema,
        response: { 201: sessionSchema, ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      const session = await options.sessions.fork(request.params.sessionId, request.body)
      return reply.code(201).send(session)
    }
  )

  server.patch(
    '/sessions/:sessionId/title',
    {
      schema: {
        params: sessionParamsSchema,
        body: setSessionTitleRequestSchema,
        response: { 200: controlReceiptSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.setTitle(request.params.sessionId, request.body)
  )

  server.patch(
    '/sessions/:sessionId/model',
    {
      schema: {
        params: sessionParamsSchema,
        body: setSessionModelRequestSchema,
        response: { 200: controlReceiptSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.setModel(request.params.sessionId, request.body)
  )

  server.patch(
    '/sessions/:sessionId/work-mode',
    {
      schema: {
        params: sessionParamsSchema,
        body: setWorkModeRequestSchema,
        response: { 200: controlReceiptSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.setWorkMode(request.params.sessionId, request.body)
  )

  server.patch(
    '/sessions/:sessionId/execution-settings',
    {
      schema: {
        params: sessionParamsSchema,
        body: setExecutionSettingsRequestSchema,
        response: { 200: controlReceiptSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.setExecutionSettings(request.params.sessionId, request.body)
  )

  server.get(
    '/sessions/:sessionId',
    {
      schema: {
        params: sessionParamsSchema,
        response: { 200: sessionSchema, ...sessionErrorResponses }
      }
    },
    async (request) => options.sessions.get(request.params.sessionId)
  )

  server.post(
    '/sessions/:sessionId/inputs',
    {
      schema: {
        params: sessionParamsSchema,
        body: sendSessionInputRequestSchema,
        response: { 202: inputAdmissionReceiptSchema, ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      const receipt = await options.sessions.send(request.params.sessionId, request.body)
      return reply.code(202).send(receipt)
    }
  )

  server.patch(
    '/sessions/:sessionId/input-queue/:inputId',
    {
      schema: {
        params: sessionInputParamsSchema,
        body: replaceQueuedInputRequestSchema,
        response: { ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      await options.sessions.replaceQueuedInput(
        request.params.sessionId,
        request.params.inputId,
        request.body
      )
      reply.code(204)
    }
  )

  server.put(
    '/sessions/:sessionId/input-queue/order',
    {
      schema: {
        params: sessionParamsSchema,
        body: reorderQueuedInputsRequestSchema,
        response: { ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      await options.sessions.reorderQueuedInputs(request.params.sessionId, request.body)
      reply.code(204)
    }
  )

  server.delete(
    '/sessions/:sessionId/input-queue/:inputId',
    {
      schema: {
        params: sessionInputParamsSchema,
        response: { ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      await options.sessions.cancelQueuedInput(request.params.sessionId, request.params.inputId)
      reply.code(204)
    }
  )

  server.post(
    '/sessions/:sessionId/input-queue/:inputId/send',
    {
      schema: {
        params: sessionInputParamsSchema,
        response: { ...sessionErrorResponses }
      }
    },
    async (request, reply) => {
      await options.sessions.sendQueuedInputNow(request.params.sessionId, request.params.inputId)
      reply.code(204)
    }
  )

  server.get(
    '/sessions/:sessionId/events',
    {
      schema: {
        params: sessionParamsSchema,
        querystring: sessionEventsQuerySchema
      }
    },
    (request, reply) => {
      const headerCursor = parseEventCursor(request.headers['last-event-id'])
      const afterSequence = Math.max(request.query.after, headerCursor)
      const stream = Readable.from(
        encodeSse(
          options.sessions.events(request.params.sessionId, afterSequence),
          SSE_HEARTBEAT_INTERVAL_MS
        )
      )
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('connection', 'keep-alive')
        .send(stream)
    }
  )
}

export async function* encodeSse(
  events: AsyncIterable<RuntimeEvent>,
  heartbeatIntervalMs: number
): AsyncGenerator<string> {
  const iterator = events[Symbol.asyncIterator]()
  let pendingEvent = iterator.next()
  try {
    while (true) {
      const heartbeat = createHeartbeatTimer(heartbeatIntervalMs)
      const next = await Promise.race([
        pendingEvent.then((result) => ({ kind: 'event' as const, result })),
        heartbeat.promise
      ])
      heartbeat.cancel()

      if (next.kind === 'heartbeat') {
        yield ': heartbeat\n\n'
        continue
      }
      if (next.result.done) return

      const event = next.result.value
      yield `id: ${event.sequence}\nevent: runtime.event\ndata: ${JSON.stringify(event)}\n\n`
      pendingEvent = iterator.next()
    }
  } finally {
    void iterator.return?.().catch(() => undefined)
  }
}

function createHeartbeatTimer(delayMs: number): {
  promise: Promise<{ kind: 'heartbeat' }>
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'heartbeat' }), delayMs)
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function parseEventCursor(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0
  return Number(value)
}
