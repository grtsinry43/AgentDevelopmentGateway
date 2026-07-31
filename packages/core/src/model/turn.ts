import type { SessionId, TurnId } from '../ids.js'
import type { RuntimeError } from './runtime-error.js'
import type { Usage } from './usage.js'

/**
 * Turn — one prompt→response cycle within a session (§9.4).
 *
 * A first-class entity so Codex `turn/steer` / `turn/interrupt` can address a live turn
 * and enforce optimistic concurrency (`expectedTurnId`). But the three runtimes disagree
 * on whether a turn is explicit (Codex `turn/start`) or implicit (Claude query→result;
 * OpenCode assistant-message = N steps). So the core DEFINES the turn and the adapter is
 * responsible for SYNTHESIZING turn boundaries on runtimes that lack the concept
 * (docs/05 §1, §3.3).
 */
export type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface Turn {
  id: TurnId
  sessionId: SessionId
  status: TurnStatus
  startedAt: number
  completedAt?: number
  /** Populated when status is 'failed' (Codex `TurnError` lives on the turn as data). */
  error?: RuntimeError
  /** OpenCode/Codex aggregate usage onto the turn (from per-step round-trips). */
  usage?: Usage
}
