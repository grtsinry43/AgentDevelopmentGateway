import { LIVE_ONLY_EVENT_TYPES, type RuntimeEvent } from '@agent-gateway/core'
import type { RuntimeEventSink } from '@agent-gateway/runtime'
import { runtimeEventWireSchema } from '@agent-gateway/shared'
import { z } from 'zod'
import type { GatewayDatabase } from '../../infrastructure/database.js'

const rowSchema = z.strictObject({ event_json: z.string() })
const liveOnlyTypes = new Set<string>(LIVE_ONLY_EVENT_TYPES)

export class SessionEventRepository implements RuntimeEventSink {
  constructor(private readonly database: GatewayDatabase) {}

  append(event: RuntimeEvent): void {
    if (liveOnlyTypes.has(event.type)) return
    this.database
      .prepare(
        `INSERT INTO session_events (
          session_id, sequence, event_id, type, timestamp, event_json
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.sessionId,
        event.sequence,
        event.id,
        event.type,
        event.timestamp,
        JSON.stringify(event)
      )
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

  discardSession(sessionId: string): void {
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
