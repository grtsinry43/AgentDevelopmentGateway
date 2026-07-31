/**
 * Usage — normalized token/cost accounting (§9.4). Optional fields; not every runtime
 * reports all. Richer than a flat token/cost record because the real runtimes split
 * cache read vs write, break down per model, and report context-window pressure
 * (Claude `ModelUsage`, Codex `TokenUsageBreakdown`) — docs/05 §Usage.
 */
export interface Usage {
  inputTokens?: number
  outputTokens?: number
  /** Tokens served from cache (Claude `cacheReadInputTokens`, Codex `cached_input`). */
  cachedInputTokens?: number
  /** Tokens written to cache (Claude `cacheCreationInputTokens`, Codex `cache_write_input`). */
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  costUsd?: number
  /** Web-search request count (Claude `webSearchRequests`). */
  webSearchRequests?: number
  /** Model context window size, for pressure/compaction UI (Codex `model_context_window`). */
  contextWindow?: number
  /** Per-model breakdown (Claude `modelUsage: Record<string, ModelUsage>`). */
  byModel?: Record<string, ModelUsage>
}

/** Per-model slice of {@link Usage}. */
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  costUsd?: number
}

/**
 * Rate-limit window state (Claude five_hour/seven_day windows, Codex account rate limits).
 * A recurring STATE, not an error — rides `usage.rate_limit_updated` (docs/05 §9).
 */
export interface RateLimitWindow {
  /** Label of the window, e.g. 'five_hour' | 'seven_day'. */
  window: string
  /** Fraction of the limit consumed, 0..1. */
  utilization?: number
  /** When the window resets (epoch ms). */
  resetsAt?: number
  hasCredits?: boolean
}
