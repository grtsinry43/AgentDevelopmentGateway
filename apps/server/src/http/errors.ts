import { AdapterError } from '@agent-gateway/core'
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError
} from 'fastify-type-provider-zod'

export type GatewayErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_CONFLICT'
  | 'PROJECT_HAS_ACTIVE_SESSIONS'
  | 'PROJECT_UNAVAILABLE'
  | 'INVALID_WORKSPACE_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_SUBSCRIPTION_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_FILE'
  | 'GIT_UNAVAILABLE'
  | 'GIT_NOT_REPOSITORY'
  | 'GIT_STATE_CHANGED'
  | 'GIT_COMMAND_FAILED'
  | 'GIT_NOTHING_TO_COMMIT'
  | 'TERMINAL_NOT_FOUND'
  | 'TERMINAL_NOT_ATTACHED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_NOT_RESUMABLE'
  | 'SESSION_ALREADY_ACTIVE'
  | 'SESSION_REVISION_CONFLICT'
  | 'INTERACTION_ID_MISMATCH'
  | 'INPUT_ID_MISMATCH'
  | 'INPUT_QUEUE_CHANGED'
  | 'QUEUED_INPUT_NOT_FOUND'
  | 'CAPABILITY_UNSUPPORTED'
  | 'ADAPTER_NOT_REGISTERED'
  | 'ADAPTER_UNAVAILABLE'
  | 'INSTALLATION_SELECTION_REQUIRED'
  | 'RUNTIME_START_FAILED'
  | 'INTERNAL_ERROR'

export class GatewayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: GatewayErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'GatewayHttpError'
  }
}

export function installErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendError(reply, request.id, 400, 'VALIDATION_ERROR', 'Request validation failed', {
        issues: error.validation
      })
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'Response validation failed')
      return sendError(reply, request.id, 500, 'INTERNAL_ERROR', 'Internal Server Error')
    }
    if (error instanceof GatewayHttpError) {
      return sendError(reply, request.id, error.statusCode, error.code, error.message, error.details)
    }
    if (error instanceof AdapterError) {
      const mapped = mapAdapterError(error)
      request.log.warn({ err: error, code: mapped.code }, 'Runtime request failed')
      return sendError(reply, request.id, mapped.statusCode, mapped.code, mapped.message)
    }

    request.log.error({ err: error }, 'Unhandled request error')
    return sendError(reply, request.id, 500, 'INTERNAL_ERROR', 'Internal Server Error')
  })
}

function mapAdapterError(error: AdapterError): GatewayHttpError {
  switch (error.runtimeError.nativeCode) {
    case 'gateway.adapter.not_registered':
      return new GatewayHttpError(422, 'ADAPTER_NOT_REGISTERED', error.message)
    case 'gateway.installation.selection_required':
      return new GatewayHttpError(409, 'INSTALLATION_SELECTION_REQUIRED', error.message)
    case 'gateway.installation.not_found':
    case 'gateway.installation.unavailable':
      return new GatewayHttpError(422, 'ADAPTER_UNAVAILABLE', error.message)
    case 'gateway.session.revision_conflict':
      return new GatewayHttpError(409, 'SESSION_REVISION_CONFLICT', error.message)
    case 'gateway.capability.unsupported':
      return new GatewayHttpError(422, 'CAPABILITY_UNSUPPORTED', error.message)
    default:
      // 未特判的 adapter 错误:透出真实 message,别用笼统的「Runtime session failed to start」误导排查。
      return new GatewayHttpError(502, 'RUNTIME_START_FAILED', error.message)
  }
}

function sendError(
  reply: FastifyReply,
  requestId: string,
  statusCode: number,
  code: GatewayErrorCode,
  message: string,
  details?: unknown
): FastifyReply {
  return reply.code(statusCode).send({
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) }
  })
}
