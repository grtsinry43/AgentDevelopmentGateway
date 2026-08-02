import { LIVE_ONLY_EVENT_TYPES, type RuntimeEvent, type SessionId } from '@agent-gateway/core'
import type { RuntimeEventSink } from '@agent-gateway/runtime'
import { runtimeEventWireSchema } from '@agent-gateway/shared'
import { z } from 'zod'
import type { GatewayDatabase } from '../../infrastructure/database.js'

const rowSchema = z.strictObject({ event_json: z.string() })
const maxSequenceRowSchema = z.strictObject({ max_sequence: z.number().nullable() })
const liveOnlyTypes = new Set<string>(LIVE_ONLY_EVENT_TYPES)

export class SessionEventRepository implements RuntimeEventSink {
  private readonly insertEvent
  private readonly updateWatermark
  private readonly selectMaxSequence
  private readonly commitDurableEvent

  constructor(private readonly database: GatewayDatabase) {
    this.insertEvent = this.database.prepare(
      `INSERT INTO session_events (
        session_id, sequence, event_id, type, timestamp, event_json
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    this.updateWatermark = this.database.prepare(
      `UPDATE sessions
       SET last_event_sequence = MAX(last_event_sequence, ?)
       WHERE id = ?`
    )
    this.selectMaxSequence = this.database.prepare(
      `SELECT MAX(sequence) AS max_sequence FROM session_events WHERE session_id = ?`
    )
    // Durable insert + session watermark must commit together so resume never
    // restarts below an already-persisted sequence after a crash/restart.
    this.commitDurableEvent = this.database.transaction(
      (event: RuntimeEvent) => {
        this.insertEvent.run(
          event.sessionId,
          event.sequence,
          event.id,
          event.type,
          event.timestamp,
          JSON.stringify(event)
        )
        this.updateWatermark.run(event.sequence, event.sessionId)
      }
    )
  }

  append(event: RuntimeEvent): void {
    if (liveOnlyTypes.has(event.type)) return
    this.commitDurableEvent(event)
  }

  /** Highest persisted sequence for a session, or 0 when the log is empty. */
  maxSequence(sessionId: string): number {
    const row = maxSequenceRowSchema.parse(
      this.selectMaxSequence.get(sessionId) ?? { max_sequence: null }
    )
    return row.max_sequence ?? 0
  }

  /**
   * Cursor that is safe for opening a new in-memory stream or allocating the next
   * durable sequence: never below either the session watermark or the event log.
   */
  durableCursor(sessionId: string, sessionWatermark: number): number {
    return Math.max(sessionWatermark, this.maxSequence(sessionId))
  }

  listAfter(sessionId: string, afterSequence = 0): RuntimeEvent[] {
    return this.database
      .prepare(
        `SELECT event_json FROM session_events
         WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC`
      )
      .all(sessionId, afterSequence)
      .map((row) => parseRuntimeEvent(rowSchema.parse(row).event_json))
  }

  discardSession(sessionId: SessionId): void {
    this.database.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId)
  }

  discardOrphans(): number {
    return this.database
      .prepare(
        `DELETE FROM session_events
         WHERE session_id NOT IN (SELECT id FROM sessions)`
      )
      .run().changes
  }
}

function parseRuntimeEvent(value: string): RuntimeEvent {
  return runtimeEventWireSchema.parse(JSON.parse(value)) as RuntimeEvent
}
