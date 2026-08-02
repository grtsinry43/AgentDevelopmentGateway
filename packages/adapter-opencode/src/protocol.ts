import type { AdapterEvent } from '@agent-gateway/core'

export interface OpenCodeEvent {
  id: string
  type: string
  data: Record<string, unknown>
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: {
    directory: string
    workspaceID?: string
  }
  metadata?: Record<string, unknown>
}

export interface OpenCodeModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface OpenCodeFileAttachment {
  uri: string
  name?: string
}

export interface OpenCodeAdmittedInput {
  admittedSeq: number
  id: string
  sessionID: string
  prompt: unknown
  delivery: 'steer' | 'queue'
  timeCreated: number
  promotedSeq?: number
}

export type OpenCodeAdapterEvent = AdapterEvent & { schemaVersion?: number }

/**
 * Normalize OpenCode SSE frames from either public surface:
 * - Official / SDK / CLI: `{ id, type, properties }` or GlobalEvent `{ directory, payload }`
 * - v2 `/api/event` + durable session SSE: `{ id, type, data, durable? }`
 *
 * Internally adapters always see `data` (properties are rewritten to data).
 */
export function parseEvent(value: unknown): OpenCodeEvent {
  const root = unwrapGlobalEvent(value)
  if (!isRecord(root)) throw new Error('OpenCode SSE frame is not an object')

  const id = stringValue(root.id) ?? `evt_${Date.now()}`
  const type = stringValue(root.type)
  const data = recordValue(root.data) ?? recordValue(root.properties) ?? {}
  if (!type) throw new Error('OpenCode SSE frame has an invalid event envelope')

  const durableValue = recordValue(root.durable)
  const durable = durableValue
    ? {
        aggregateID: requiredString(durableValue, 'aggregateID', 'event durable metadata'),
        seq: requiredNumber(durableValue, 'seq', 'event durable metadata'),
        version: requiredNumber(durableValue, 'version', 'event durable metadata'),
      }
    : undefined
  const locationValue = recordValue(root.location)
  const location = locationValue
    ? {
        directory: requiredString(locationValue, 'directory', 'event location'),
        ...(stringValue(locationValue.workspaceID)
          ? { workspaceID: stringValue(locationValue.workspaceID) }
          : {}),
      }
    : undefined

  return {
    id,
    type,
    data,
    ...(durable ? { durable } : {}),
    ...(location ? { location } : {}),
    ...(recordValue(root.metadata) ? { metadata: recordValue(root.metadata) } : {}),
  }
}

/** CLI/SDK `GET /global/event` wraps bus events as `{ directory?, payload }`. */
function unwrapGlobalEvent(value: unknown): unknown {
  if (!isRecord(value)) return value
  const payload = recordValue(value.payload)
  if (!payload || stringValue(payload.type) === undefined) return value
  return payload
}

export function unwrapData(value: unknown, label: string): unknown {
  const response = recordValue(value)
  if (!response || !('data' in response)) throw new Error(`${label} returned an invalid response`)
  return response.data
}

export function parseAdmittedInput(value: unknown): OpenCodeAdmittedInput {
  const data = recordValue(unwrapData(value, 'OpenCode prompt'))
  if (!data) throw new Error('OpenCode prompt response has invalid data')
  const delivery = stringValue(data.delivery)
  if (delivery !== 'steer' && delivery !== 'queue') {
    throw new Error('OpenCode prompt response has invalid delivery')
  }
  return {
    admittedSeq: requiredNumber(data, 'admittedSeq', 'OpenCode admitted input'),
    id: requiredString(data, 'id', 'OpenCode admitted input'),
    sessionID: requiredString(data, 'sessionID', 'OpenCode admitted input'),
    prompt: data.prompt,
    delivery,
    timeCreated: requiredNumber(data, 'timeCreated', 'OpenCode admitted input'),
    ...(numberValue(data.promotedSeq) === undefined
      ? {}
      : { promotedSeq: numberValue(data.promotedSeq) }),
  }
}

export function parseModelRef(value: unknown, label = 'OpenCode model'): OpenCodeModelRef {
  const model = recordValue(value)
  if (!model) throw new Error(`${label} is not an object`)
  return {
    id: requiredString(model, 'id', label),
    providerID: requiredString(model, 'providerID', label),
    ...(stringValue(model.variant) ? { variant: stringValue(model.variant) } : {}),
  }
}

export function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const result = stringValue(value[key])
  if (!result) throw new Error(`${label} has no ${key}`)
  return result
}

export function requiredNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const result = numberValue(value[key])
  if (result === undefined) throw new Error(`${label} has no ${key}`)
  return result
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
