import {
  AdapterError,
  type ServerRequest,
  type ServerRequestHandler,
  type ServerResponse,
} from '@agent-gateway/core'

/**
 * Minimal host handler for adapter server-requests.
 * Answers locally safe reads; rejects everything else with a structured error
 * (no Desktop round-trip for dynamic tools / attestation).
 */
export const handleHostServerRequest: ServerRequestHandler = async (
  request: ServerRequest,
): Promise<ServerResponse> => {
  if (request.method === 'codex.currentTime.read') {
    return {
      id: request.id,
      result: { currentTimeAt: Math.floor(Date.now() / 1_000) },
    }
  }

  throw new AdapterError({
    code: 'not_implemented',
    layer: 'transport',
    nativeCode: 'gateway.server_request.unsupported',
    message: `Host does not handle server request: ${request.method}`,
  })
}
