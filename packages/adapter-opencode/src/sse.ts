import { OpenCodeHttpClient } from './http-client.js'
import { parseEvent, type OpenCodeEvent } from './protocol.js'

export interface EventPump {
  abort: AbortController
  done: Promise<void>
}

export function startEventPump(
  client: OpenCodeHttpClient,
  path: string,
  query: Record<string, string | number | undefined>,
  onEvent: (event: OpenCodeEvent) => void,
  onFailure: (error: unknown) => void,
): EventPump {
  const abort = new AbortController()
  const done = pump(client, path, query, abort.signal, onEvent).catch((error: unknown) => {
    if (!abort.signal.aborted) onFailure(error)
  })
  return { abort, done }
}

async function pump(
  client: OpenCodeHttpClient,
  path: string,
  query: Record<string, string | number | undefined>,
  signal: AbortSignal,
  onEvent: (event: OpenCodeEvent) => void,
): Promise<void> {
  const stream = await client.stream(path, { query, signal })
  for await (const value of parseSse(stream)) {
    try {
      onEvent(parseEvent(value))
    } catch {
      // Skip malformed frames; do not tear down the whole subscription.
    }
  }
  if (!signal.aborted) throw new Error(`OpenCode SSE stream ended unexpectedly: ${path}`)
}

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield parseJson(data)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error('OpenCode SSE frame contains invalid JSON', { cause: error })
  }
}
