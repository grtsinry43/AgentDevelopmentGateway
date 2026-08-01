import type { RawData } from 'ws'
import {
  createTerminalRequestSchema,
  terminalClientMessageSchema,
  terminalDescriptorSchema,
  terminalListResponseSchema,
  terminalParamsSchema,
  projectTerminalParamsSchema,
  type TerminalServerMessage
} from '@agent-gateway/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '../../http/schemas.js'
import {
  TERMINAL_NOT_FOUND_CLOSE_CODE,
  type TerminalAttachment,
  type TerminalService
} from './service.js'

const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024

interface TerminalRoutesOptions {
  terminals: TerminalService
}

const terminalErrorResponses = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  500: errorResponseSchema
}

export const terminalRoutes: FastifyPluginAsyncZod<TerminalRoutesOptions> = async (
  server,
  options
) => {
  server.get(
    '/projects/:projectId/terminals',
    {
      schema: {
        params: projectTerminalParamsSchema,
        response: { 200: terminalListResponseSchema, ...terminalErrorResponses }
      }
    },
    async (request) => ({ terminals: options.terminals.list(request.params.projectId) })
  )

  server.post(
    '/projects/:projectId/terminals',
    {
      schema: {
        params: projectTerminalParamsSchema,
        body: createTerminalRequestSchema,
        response: { 201: terminalDescriptorSchema, ...terminalErrorResponses }
      }
    },
    async (request, reply) => {
      const terminal = await options.terminals.create(request.params.projectId, request.body)
      return reply.code(201).send(terminal)
    }
  )

  server.delete(
    '/terminals/:terminalId',
    {
      schema: {
        params: terminalParamsSchema,
        response: { 204: z.undefined(), ...terminalErrorResponses }
      }
    },
    async (request, reply) => {
      options.terminals.close(request.params.terminalId)
      return reply.code(204).send()
    }
  )

  server.get(
    '/terminals/:terminalId/attach',
    {
      websocket: true,
      schema: { params: terminalParamsSchema }
    },
    (socket, request) => {
      const terminalId = request.params.terminalId
      let attached = false
      const attachment: TerminalAttachment = {
        send(message) {
          if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
            socket.close(1013, 'terminal_transport_backpressure')
            return
          }
          sendControl(socket, message)
        },
        close(code, reason) {
          if (socket.readyState < 2) socket.close(code, reason)
        }
      }

      socket.on('message', async (raw: RawData, isBinary: boolean) => {
        if (isBinary) {
          sendControl(socket, {
            type: 'terminal.error',
            code: 'INVALID_TERMINAL_MESSAGE',
            message: 'Terminal control messages must be JSON text'
          })
          return
        }
        const message = parseClientMessage(raw)
        if (!message.success) {
          sendControl(socket, {
            type: 'terminal.error',
            code: 'INVALID_TERMINAL_MESSAGE',
            message: message.message
          })
          return
        }
        try {
          switch (message.value.type) {
            case 'terminal.attach':
              if (attached) throw new Error('Terminal socket is already attached')
              attached = true
              await options.terminals.attach(
                terminalId,
                attachment,
                message.value.afterSequence,
                message.value.cols,
                message.value.rows
              )
              break
            case 'terminal.input':
              options.terminals.write(terminalId, attachment, message.value.data)
              break
            case 'terminal.resize':
              options.terminals.resize(
                terminalId,
                attachment,
                message.value.cols,
                message.value.rows
              )
              break
            case 'terminal.ack':
              options.terminals.acknowledge(terminalId, attachment, message.value.sequence)
              break
          }
        } catch (error) {
          request.log.warn({ err: error, terminalId }, 'Terminal control message failed')
          if (message.value.type === 'terminal.attach') {
            socket.close(TERMINAL_NOT_FOUND_CLOSE_CODE, 'terminal_attach_failed')
            return
          }
          sendControl(socket, {
            type: 'terminal.error',
            code: 'TERMINAL_CONTROL_FAILED',
            message: error instanceof Error ? error.message : 'Terminal control failed'
          })
        }
      })
      socket.on('close', () => options.terminals.detach(terminalId, attachment))
      socket.on('error', (error) =>
        request.log.warn({ err: error, terminalId }, 'Terminal WebSocket failed')
      )

    }
  )
}

function sendControl(
  socket: { readyState: number; send(data: string): void },
  message: TerminalServerMessage
): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(message))
}

function parseClientMessage(
  raw: RawData
):
  | { success: true; value: ReturnType<typeof terminalClientMessageSchema.parse> }
  | { success: false; message: string } {
  try {
    return { success: true, value: terminalClientMessageSchema.parse(JSON.parse(raw.toString())) }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Invalid terminal message'
    }
  }
}
