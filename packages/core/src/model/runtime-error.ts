/**
 * RuntimeError — normalized error across all adapters (§9.9 "error normalization").
 *
 * Layered, not flat. The three real runtimes (and cradle) keep FOUR error concerns
 * apart, and conflating them loses meaning (see docs/05-core-design.md §9):
 *   - transport   — connection / protocol / auth failures of the adapter↔runtime link.
 *   - turn        — a turn failed as DATA (Codex `TurnError` lives on the Turn; Claude
 *                   `SDKResultError.terminal_reason`). Surfaced via `turn.failed`, not thrown.
 *   - resource    — rate-limit / budget / context exhaustion. Usually a recurring STATE
 *                   (see `usage.rate_limit_updated`), modeled as an error only when terminal.
 *   - stream-end  — the host↔client stream ended and can't be cheaply replayed
 *                   (snapshot-required / backpressure). See `wire/` StreamEndReason.
 */
export type ErrorLayer = 'transport' | 'turn' | 'resource' | 'stream-end'

/**
 * Severity ladder (Codex `warning`/`guardianWarning`/`deprecationNotice`). Advisory
 * events ride `runtime.warning`; only `error`/`fatal` typically end a turn.
 */
export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info'

/**
 * Normalized code. Broader than the original 7 values so Claude's 18 `TerminalReason`s
 * and Codex's `codex_error_info` can map without collapsing distinct meanings; the exact
 * native value is preserved in `nativeCode`, and structured extras in `details`.
 */
export type RuntimeErrorCode =
  | 'connection'
  | 'protocol'
  | 'auth'
  | 'rate_limit'
  | 'budget_exhausted' // Claude error_max_budget_usd
  | 'max_turns' // Claude error_max_turns
  | 'context_overflow' // prompt_too_long / context window exceeded
  | 'model_refusal' // Claude SDKModelRefusalFallback
  | 'not_implemented'
  | 'interrupted'
  | 'declined' // user/policy declined (Codex Declined, distinct from a failure)
  | 'unknown'

export interface RuntimeError {
  code: RuntimeErrorCode
  message: string
  /** Which concern this error belongs to; defaults to 'transport' when unset. */
  layer?: ErrorLayer
  severity?: ErrorSeverity
  /** Transient (Codex `will_retry`): the runtime auto-retries and the turn continues. */
  retriable?: boolean
  /** Delay before the retry lands (Claude `retry_delay_ms`). */
  retryAfterMs?: number
  /** Original code string from the runtime, kept verbatim for debugging. */
  nativeCode?: string
  /**
   * Structured extras with no dedicated field: Claude `permission_denials` /
   * `terminal_reason`, Codex `codex_error_info` / `additional_details`. Debug-only;
   * may be redacted per config (§9.5).
   */
  details?: unknown
}
