import type { MessageId, TurnId } from '../ids.js'

/** Message — a user or assistant message within a turn (§9.4). */
export type MessageRole = 'user' | 'assistant'

export interface Message {
  id: MessageId
  turnId: TurnId
  role: MessageRole
  createdAt: number
}
