/**
 * Branded id types. Zero runtime cost — the brand exists only at the type level to
 * stop id-mixing bugs (passing a TurnId where a SessionId is expected, etc.).
 *
 * `AdapterId` is a closed union per requirements §7.3/§7.7; the rest are open brands
 * so adapters can pass native runtime ids through unchanged.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B }

export type SessionId = Brand<string, 'SessionId'>
export type TurnId = Brand<string, 'TurnId'>
export type MessageId = Brand<string, 'MessageId'>
export type ToolCallId = Brand<string, 'ToolCallId'>
export type InteractionId = Brand<string, 'InteractionId'>

/** The three runtimes the gateway targets first (§7.3, §7.7). */
export type AdapterId = 'claude-code' | 'codex' | 'opencode'

export const asSessionId = (value: string): SessionId => value as SessionId
export const asTurnId = (value: string): TurnId => value as TurnId
export const asMessageId = (value: string): MessageId => value as MessageId
export const asToolCallId = (value: string): ToolCallId => value as ToolCallId
export const asInteractionId = (value: string): InteractionId => value as InteractionId
