import { basename } from 'node:path'
import type {
  SessionContext,
  TurnContext,
  UserInput,
} from '@agent-gateway/core'
import { unsupportedError } from './protocol.js'

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }
  | { type: 'mention'; name: string; path: string }

export function mapUserInput(input: UserInput): CodexUserInput[] {
  const result: CodexUserInput[] = [
    { type: 'text', text: input.text, text_elements: [] },
  ]
  for (const attachment of input.attachments ?? []) {
    if (attachment.data !== undefined) {
      throw unsupportedError(
        'Codex app-server UserInput cannot represent inline attachment data; provide a local path',
        'codex.input.inline_data_unsupported',
      )
    }
    if (!attachment.path) {
      throw unsupportedError(
        'Codex attachment requires a local path',
        'codex.input.path_required',
      )
    }
    result.push(
      attachment.kind === 'image'
        ? { type: 'localImage', path: attachment.path }
        : {
            type: 'mention',
            name: basename(attachment.path) || attachment.path,
            path: attachment.path,
          },
    )
  }
  return result
}

export function mapSessionContext(context: SessionContext | undefined): string | undefined {
  if (!context || context.fragments.length === 0) return undefined
  const unsupported = context.fragments.find(
    (fragment) => fragment.role !== 'instruction' || fragment.trust !== 'application',
  )
  if (unsupported) {
    throw unsupportedError(
      `Codex developerInstructions cannot preserve session fragment ${unsupported.key} authority (${unsupported.role}/${unsupported.trust})`,
      'codex.context.session_authority_unsupported',
    )
  }
  return context.fragments
    .map((fragment) => `<gateway-context key="${fragment.key}">\n${fragment.content}\n</gateway-context>`)
    .join('\n\n')
}

export function mapTurnContext(
  context: TurnContext | undefined,
): Record<string, { value: string; kind: 'application' | 'untrusted' }> | undefined {
  if (!context) return undefined
  const unsupported = context.fragments.find(
    (fragment) => fragment.role === 'instruction' && fragment.trust !== 'application',
  )
  if (unsupported) {
    throw unsupportedError(
      `Codex additionalContext cannot preserve untrusted instruction fragment ${unsupported.key}`,
      'codex.context.turn_authority_unsupported',
    )
  }
  return Object.fromEntries(
    context.fragments.map((fragment) => [
      fragment.key,
      {
        value: fragment.content,
        kind: fragment.role === 'instruction' ? 'application' : 'untrusted',
      },
    ]),
  )
}
