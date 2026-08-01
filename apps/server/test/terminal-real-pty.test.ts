import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TerminalServerMessage } from '@agent-gateway/shared'
import { TerminalService, type TerminalAttachment } from '../src/features/terminals/service.js'

test(
  'runs a command through a real PTY and reports its output and exit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-gateway-real-pty-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const service = new TerminalService({
      projects: {
        require: () => undefined,
        get: async () => ({ path: directory, availability: 'available' as const })
      },
      environment: { ...stringEnvironment(process.env), SHELL: '/bin/sh' },
      retentionMs: 20
    })
    t.after(() => service.shutdown())

    const descriptor = await service.create(PROJECT_ID, { cols: 80, rows: 24 })
    const attachment = new RecordingAttachment()
    await service.attach(descriptor.id, attachment, undefined, 80, 24)
    service.write(descriptor.id, attachment, "printf 'gateway-pty-smoke\\n'; exit 7\r")

    await waitFor(() => attachment.messages.some((message) => message.type === 'terminal.exit'))
    const output = attachment.messages
      .filter(
        (message): message is Extract<TerminalServerMessage, { type: 'terminal.output' }> =>
          message.type === 'terminal.output'
      )
      .map((message) => message.data)
      .join('')
    assert.match(output, /gateway-pty-smoke/)
    assert.deepEqual(
      attachment.messages.find((message) => message.type === 'terminal.exit'),
      { type: 'terminal.exit', exitCode: 7, signal: 0 }
    )
  }
)

const PROJECT_ID = 'b6bd9c80-722c-4266-866b-44dce29e7396'

class RecordingAttachment implements TerminalAttachment {
  readonly messages: TerminalServerMessage[] = []

  send(message: TerminalServerMessage): void {
    this.messages.push(message)
  }

  close(): void {}
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the real PTY to exit')
}
