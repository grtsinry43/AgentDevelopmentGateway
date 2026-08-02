import type { InputDelivery, ProviderInputReceipt, UserInput } from '../adapter/io.js'
import type { TurnId } from '../ids.js'
import type { RuntimeError } from '../model/runtime-error.js'

export type InputQueueEntryStatus = 'pending' | 'delivered' | 'failed' | 'cancelled'

/** Durable scheduling state for one user-authored input. */
export interface InputQueueEntry {
  /** Equals UserInput.clientMessageId and is the idempotency key across every layer. */
  id: string
  input: UserInput
  requestedDelivery: InputDelivery
  /** Runtime-resolved behavior after applying the adapter's capabilities. */
  effectiveDelivery?: InputDelivery
  status: InputQueueEntryStatus
  admittedSequence: number
  /** Position among pending queue entries. Zero-based and contiguous. */
  position?: number
  /** Turn opened or steered after provider acceptance. */
  turnId?: TurnId
  /** Provider-scoped acknowledgement captured after adapter acceptance. */
  providerReceipt?: ProviderInputReceipt
  error?: RuntimeError
  createdAt: number
  updatedAt: number
}
