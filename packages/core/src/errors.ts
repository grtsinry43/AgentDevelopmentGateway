import type { RuntimeError, RuntimeErrorCode } from './model/runtime-error.js'

/**
 * Thrown by adapter skeleton methods that have a real implementation planned but
 * not yet wired. Distinct class so callers/tests can assert on it precisely.
 */
export class NotImplementedError extends Error {
  readonly code: RuntimeErrorCode = 'not_implemented'
  constructor(method: string) {
    super(`Not implemented: ${method}`)
    this.name = 'NotImplementedError'
  }
}

/** Carries a normalized {@link RuntimeError} across the adapter boundary (§9.9). */
export class AdapterError extends Error {
  constructor(readonly runtimeError: RuntimeError) {
    super(runtimeError.message)
    this.name = 'AdapterError'
  }
}

/** Normalize an arbitrary thrown value into a common {@link RuntimeError} (§9.9). */
export function toRuntimeError(value: unknown, code: RuntimeErrorCode = 'unknown'): RuntimeError {
  if (value instanceof AdapterError) return value.runtimeError
  if (value instanceof NotImplementedError) {
    return { code: 'not_implemented', message: value.message }
  }
  if (value instanceof Error) {
    return { code, message: value.message }
  }
  return { code, message: String(value) }
}
