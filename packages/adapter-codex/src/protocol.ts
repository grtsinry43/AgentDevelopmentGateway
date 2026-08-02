import { AdapterError } from '@agent-gateway/core'

export type JsonObject = Record<string, unknown>

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function requiredString(value: JsonObject, key: string, label: string): string {
  const result = stringValue(value[key])
  if (!result) throw protocolError(`${label} has no ${key}`)
  return result
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function readThreadId(value: unknown, label: string): string {
  if (!isRecord(value) || !isRecord(value.thread)) {
    throw protocolError(`${label} returned no thread`)
  }
  return requiredString(value.thread, 'id', label)
}

export function readNativeTurnId(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.turn) ? stringValue(value.turn.id) : undefined
}

export function protocolError(message: string, nativeCode?: string): AdapterError {
  return new AdapterError({
    code: 'protocol',
    layer: 'transport',
    ...(nativeCode ? { nativeCode } : {}),
    message,
  })
}

export function unsupportedError(message: string, nativeCode?: string): AdapterError {
  return new AdapterError({
    code: 'not_implemented',
    layer: 'transport',
    ...(nativeCode ? { nativeCode } : {}),
    message,
  })
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
