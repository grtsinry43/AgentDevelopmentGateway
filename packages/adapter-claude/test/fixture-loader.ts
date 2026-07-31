import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export async function loadFixture(name: string): Promise<SDKMessage[]> {
  const content: unknown = JSON.parse(await readFile(resolve(fixtureDirectory, `${name}.json`), 'utf8'))
  if (!Array.isArray(content)) throw new Error(`Fixture ${name} must contain an array`)
  return content as SDKMessage[]
}
