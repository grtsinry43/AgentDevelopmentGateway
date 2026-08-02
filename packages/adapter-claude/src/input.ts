import {
  AdapterError,
  type SessionContext,
} from '@agent-gateway/core'

/** Map SessionContext instruction fragments into Claude Code systemPrompt.append text. */
export function mapSessionContext(context: SessionContext | undefined): string | undefined {
  if (!context || context.fragments.length === 0) return undefined
  const unsupported = context.fragments.find(
    (fragment) => fragment.role !== 'instruction' || fragment.trust !== 'application',
  )
  if (unsupported) {
    throw new AdapterError({
      code: 'not_implemented',
      nativeCode: 'claude.context.session_authority_unsupported',
      message: `Claude systemPrompt.append cannot preserve session fragment ${unsupported.key} authority (${unsupported.role}/${unsupported.trust})`,
    })
  }
  return context.fragments
    .map((fragment) => `<gateway-context key="${fragment.key}">\n${fragment.content}\n</gateway-context>`)
    .join('\n\n')
}
