import { basename, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AdapterError, type ModelSelection, type UserInput } from '@agent-gateway/core'
import type { OpenCodeFileAttachment, OpenCodeModelRef } from './protocol.js'

export function toModelRef(selection: ModelSelection): OpenCodeModelRef {
  const separator = selection.model.indexOf('/')
  if (separator <= 0 || separator === selection.model.length - 1) {
    throw protocolError('OpenCode models must use provider/model format')
  }
  return {
    providerID: selection.model.slice(0, separator),
    id: selection.model.slice(separator + 1),
    ...(selection.reasoningEffort ? { variant: selection.reasoningEffort } : {}),
  }
}

/** OpenCode Session.Message.ID requires the `msg_` prefix; Gateway IDs are opaque UUIDs. */
export function toNativeMessageId(clientMessageId: string): string {
  return clientMessageId.startsWith('msg_') ? clientMessageId : `msg_${clientMessageId}`
}

export function toPrompt(
  input: UserInput,
  projectPath: string,
): { text: string; files?: OpenCodeFileAttachment[] } {
  const files = input.attachments?.map((attachment) => {
    if (attachment.data !== undefined) {
      throw protocolError(
        'OpenCode 1.18.10 PromptInput does not prove inline attachment data is supported; provide a file path',
      )
    }
    if (!attachment.path) throw protocolError('OpenCode attachments require a file path')
    const path = isAbsolute(attachment.path)
      ? attachment.path
      : resolve(projectPath, attachment.path)
    return {
      uri: pathToFileURL(path).href,
      name: basename(path),
    }
  })
  return {
    text: input.text,
    ...(files?.length ? { files } : {}),
  }
}

function protocolError(message: string): AdapterError {
  return new AdapterError({ code: 'protocol', layer: 'transport', message })
}
