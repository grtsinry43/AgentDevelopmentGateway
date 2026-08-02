import type { RuntimeEvent, SessionId } from '@agent-gateway/core'
import {
  applySessionItemEvent,
  clearFinalizedItems,
  createSessionItemState,
  type SessionItemState,
} from '@agent-gateway/shared'
import { SessionItemRepository } from './item-repository.js'

interface MaterializerEntry {
  state: SessionItemState
  reconciled: boolean
}

/**
 * 会话物化器:把到达的 durable 事件增量投影成成品块(session_items)。
 *
 * - 每事件摊 O(1):emitted 块落库后 `clearFinalizedItems`,内存只留 in-flight + delta 上下文
 * - 首次消费某会话时懒对账:从 durable 事件日志重放一遍重建 in-flight 上下文
 *   (completed 事件带权威全文,delta 不落库也不影响成品正确性),已持久化的块不重写
 */
export class SessionItemizer {
  private readonly sessions = new Map<string, MaterializerEntry>()

  constructor(
    private readonly items: SessionItemRepository,
    private readonly events: { listAfter(sessionId: string, afterSequence: number): RuntimeEvent[] }
  ) {}

  consume(event: RuntimeEvent): void {
    const sessionId = event.sessionId
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { state: createSessionItemState(), reconciled: false }
      this.sessions.set(sessionId, entry)
    }
    if (!entry.reconciled) {
      // sink 先持久化当前事件再喂给物化器,所以对账必须排除当前事件本身
      // (listAfter 升序,遇到 sequence >= 当前事件即停)。
      for (const past of this.events.listAfter(sessionId, 0)) {
        if (past.sequence >= event.sequence) break
        applySessionItemEvent(entry.state, past)
      }
      clearFinalizedItems(entry.state)
      entry.reconciled = true
    }
    const emitted = applySessionItemEvent(entry.state, event)
    if (emitted.length > 0) {
      this.items.upsert(sessionId, emitted)
      clearFinalizedItems(entry.state)
    }
  }

  discardSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId)
    this.items.discardSession(sessionId)
  }
}
