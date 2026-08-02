import type { RuntimeEvent, SessionId } from '@agent-gateway/core'
import type { RuntimeEventSink } from '@agent-gateway/runtime'
import type { SessionEventRepository } from './event-repository.js'
import type { SessionItemizer } from './session-itemizer.js'

/**
 * 组合事件 sink:既持久化 durable 事件(过滤 live-only),又喂给物化器产出成品块。
 * 作为 RuntimeSessionManager 的 eventSink,覆盖全部会话的每一条事件。
 */
export class MaterializedEventSink implements RuntimeEventSink {
  constructor(
    private readonly events: SessionEventRepository,
    private readonly itemizer: SessionItemizer
  ) {}

  append(event: RuntimeEvent): void {
    this.events.append(event)
    this.itemizer.consume(event)
  }

  discardSession(sessionId: SessionId): void {
    this.events.discardSession(sessionId)
    this.itemizer.discardSession(sessionId)
  }
}
