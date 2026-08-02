import type { SessionId } from '@agent-gateway/core'
import type { SessionItem } from '@agent-gateway/shared'
import { z } from 'zod'
import type { GatewayDatabase } from '../../infrastructure/database.js'

const itemRowSchema = z.strictObject({ item_json: z.string() })

/**
 * 会话成品块(session_items)存储 —— 物化 read model。每个 item_id 一行
 * (changes.updated 同 id 更新 sequence + payload),按 sequence 分页。
 */
export class SessionItemRepository {
  private readonly upsertItem
  private readonly selectMaxSequence
  private readonly selectBefore

  constructor(private readonly database: GatewayDatabase) {
    this.upsertItem = this.database.prepare(
      `INSERT INTO session_items (session_id, item_id, sequence, kind, item_json)
       VALUES (@sessionId, @itemId, @sequence, @kind, @itemJson)
       ON CONFLICT (session_id, item_id)
       DO UPDATE SET sequence = excluded.sequence, item_json = excluded.item_json`
    )
    this.selectMaxSequence = this.database.prepare(
      `SELECT MAX(sequence) AS max_sequence FROM session_items WHERE session_id = ?`
    )
    this.selectBefore = this.database.prepare(
      `SELECT item_json FROM session_items
       WHERE session_id = ? AND sequence < ?
       ORDER BY sequence DESC LIMIT ?`
    )
  }

  /** 事务内批量 upsert 一批已定型块。 */
  upsert(sessionId: string, items: SessionItem[]): void {
    if (items.length === 0) return
    const run = this.database.transaction((entries: SessionItem[]) => {
      for (const item of entries) {
        this.upsertItem.run({
          sessionId,
          itemId: item.id,
          sequence: item.sequence,
          kind: item.itemKind,
          itemJson: JSON.stringify(item)
        })
      }
    })
    run(items)
  }

  /** 已物化到的最大 sequence(0 表示还没有任何块)。 */
  headSequence(sessionId: string): number {
    const row = z
      .strictObject({ max_sequence: z.number().nullable() })
      .parse(this.selectMaxSequence.get(sessionId) ?? { max_sequence: null })
    return row.max_sequence ?? 0
  }

  /** 取 `sequence < before` 的最多 limit 条成品块(升序)。 */
  listBefore(sessionId: string, before: number, limit: number): SessionItem[] {
    return this.selectBefore
      .all(sessionId, before, limit)
      .reverse()
      .map((row) => JSON.parse(itemRowSchema.parse(row).item_json) as SessionItem)
  }

  discardSession(sessionId: SessionId): void {
    this.database.prepare('DELETE FROM session_items WHERE session_id = ?').run(sessionId)
  }
}
