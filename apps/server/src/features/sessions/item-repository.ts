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
  private readonly selectSequenceOf
  private readonly selectMessagesAfter
  private readonly selectItemById

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
    this.selectSequenceOf = this.database.prepare(
      `SELECT sequence FROM session_items WHERE session_id = ? AND item_id = ?`
    )
    this.selectItemById = this.database.prepare(
      `SELECT item_json FROM session_items WHERE session_id = ? AND item_id = ?`
    )
    this.selectMessagesAfter = this.database.prepare(
      `SELECT COUNT(*) AS count FROM session_items
       WHERE session_id = ? AND sequence > ? AND kind = 'message'`
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

  /** 取某个 item 的 sequence(找不到返回 undefined)。 */
  sequenceOf(sessionId: string, itemId: string): number | undefined {
    const row = z
      .strictObject({ sequence: z.number().optional() })
      .parse(this.selectSequenceOf.get(sessionId, itemId) ?? {})
    return row.sequence
  }

  /** 按 item id 取成品块。 */
  findById(sessionId: string, itemId: string): SessionItem | undefined {
    const row = z
      .strictObject({ item_json: z.string() })
      .safeParse(this.selectItemById.get(sessionId, itemId) ?? {})
    if (!row.success) return undefined
    return JSON.parse(row.data.item_json) as SessionItem
  }

  /** 统计 `sequence > after` 的 message 块数量(回退预览用)。 */
  countMessagesAfter(sessionId: string, after: number): number {
    const row = z
      .strictObject({ count: z.number() })
      .parse(this.selectMessagesAfter.get(sessionId, after) ?? { count: 0 })
    return row.count
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

  /** 原生回退:删除 `sequence > after` 的物化块。 */
  truncateAfter(sessionId: SessionId, after: number): void {
    this.database
      .prepare('DELETE FROM session_items WHERE session_id = ? AND sequence > ?')
      .run(sessionId, after)
  }
}
