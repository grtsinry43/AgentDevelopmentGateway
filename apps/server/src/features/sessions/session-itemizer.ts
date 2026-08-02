import type { RuntimeEvent, SessionId } from '@agent-gateway/core'
import {
  applySessionItemEvent,
  clearFinalizedItems,
  createSessionItemState,
  type SessionItem,
  type SessionItemState,
} from '@agent-gateway/shared'
import { SessionItemRepository } from './item-repository.js'

interface MaterializerEntry {
  state: SessionItemState
  reconciled: boolean
}

/**
 * 会话物化器:把 durable 事件增量投影成成品块(session_items)。
 *
 * - 首次访问(打开会话或第一条实时事件)时 `ensureMaterialized` 全量回放日志,
 *   把历史全部物化落库(upsert 幂等);之后每事件摊 O(1):emitted 落库后
 *   `clearFinalizedItems`,内存只留 in-flight + delta 上下文。
 * - completed 事件带权威全文,delta 不落库也不影响成品正确性。
 */
export class SessionItemizer {
  private readonly sessions = new Map<string, MaterializerEntry>()

  constructor(
    private readonly items: SessionItemRepository,
    private readonly events: { listAfter(sessionId: string, afterSequence: number): RuntimeEvent[] }
  ) {}

  /** 回填:全量重放日志,把历史物化落库(幂等)。首次访问必调。 */
  ensureMaterialized(sessionId: string): void {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { state: createSessionItemState(), reconciled: false }
      this.sessions.set(sessionId, entry)
    }
    if (entry.reconciled) return
    const emittedAll: SessionItem[] = []
    for (const past of this.events.listAfter(sessionId, 0)) {
      const emitted = applySessionItemEvent(entry.state, past)
      if (emitted.length > 0) emittedAll.push(...emitted)
    }
    if (emittedAll.length > 0) this.items.upsert(sessionId, emittedAll)
    clearFinalizedItems(entry.state)
    entry.reconciled = true
  }

  consume(event: RuntimeEvent): void {
    this.ensureMaterialized(event.sessionId)
    const entry = this.sessions.get(event.sessionId)!
    const emitted = applySessionItemEvent(entry.state, event)
    if (emitted.length > 0) {
      this.items.upsert(event.sessionId, emitted)
      clearFinalizedItems(entry.state)
    }
  }

  discardSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId)
    this.items.discardSession(sessionId)
  }
}
