import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, type CanUseTool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = resolve(packageRoot, 'test/fixtures')
const claudeSettingsPath = resolve(homedir(), '.claude/settings.json')

async function* singlePrompt(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }
}

async function record(
  name: string,
  prompt: string,
  options: { tools: string[]; canUseTool?: CanUseTool; expectPermissionCallback?: boolean },
): Promise<void> {
  const fixtureCwd = await mkdtemp(resolve(tmpdir(), 'agent-gateway-claude-fixture-'))
  const canonicalFixtureCwd = await realpath(fixtureCwd)
  const messages: SDKMessage[] = []
  const providerEnvironment = await loadProviderEnvironment()
  let permissionCallbackCount = 0
  const canUseTool: CanUseTool | undefined = options.canUseTool
    ? async (toolName, input, callbackOptions) => {
        permissionCallbackCount += 1
        return options.canUseTool!(toolName, input, callbackOptions)
      }
    : undefined
  const session = query({
    prompt: singlePrompt(prompt),
    options: {
      cwd: canonicalFixtureCwd,
      persistSession: false,
      includePartialMessages: true,
      settingSources: [],
      env: providerEnvironment,
      tools: options.tools,
      canUseTool,
      permissionMode: 'default',
      settings: options.expectPermissionCallback ? { permissions: { ask: ['Bash(*)'] } } : undefined,
      maxTurns: 2,
    },
  })

  try {
    for await (const message of session) {
      messages.push(message)
      if (message.type === 'result') break
    }
  } finally {
    session.close()
    await rm(fixtureCwd, { recursive: true, force: true })
  }

  if (options.expectPermissionCallback && permissionCallbackCount !== 1) {
    throw new Error(`Expected one permission callback, received ${permissionCallbackCount}`)
  }

  const sanitized = sanitize(messages, [fixtureCwd, canonicalFixtureCwd])
  await mkdir(fixtureDirectory, { recursive: true })
  await writeFile(resolve(fixtureDirectory, `${name}.json`), `${JSON.stringify(sanitized, null, 2)}\n`)
}

async function loadProviderEnvironment(): Promise<NodeJS.ProcessEnv> {
  const settings = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as unknown
  const configuredEnvironment = readSettingsEnvironment(settings)
  const providerEnvironment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(configuredEnvironment)) {
    if (key.startsWith('ANTHROPIC_') && typeof value === 'string') {
      providerEnvironment[key] = value
    }
  }

  if (typeof providerEnvironment.ANTHROPIC_BASE_URL !== 'string') {
    throw new Error(`Missing ANTHROPIC_BASE_URL in ${claudeSettingsPath}`)
  }
  if (
    typeof providerEnvironment.ANTHROPIC_AUTH_TOKEN !== 'string' &&
    typeof providerEnvironment.ANTHROPIC_API_KEY !== 'string'
  ) {
    throw new Error(`Missing Anthropic credentials in ${claudeSettingsPath}`)
  }

  return {
    ...process.env,
    ...providerEnvironment,
  }
}

function readSettingsEnvironment(settings: unknown): Record<string, unknown> {
  if (typeof settings !== 'object' || settings === null || !('env' in settings)) {
    throw new Error(`Missing env object in ${claudeSettingsPath}`)
  }
  const environment = settings.env
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
    throw new Error(`Invalid env object in ${claudeSettingsPath}`)
  }
  return environment as Record<string, unknown>
}

const denyTool: CanUseTool = async (_toolName, _input, options) => ({
  behavior: 'deny',
  message: 'Denied by the fixture recorder; no command was executed.',
  toolUseID: options.toolUseID,
})

await record('text-turn', 'Reply with exactly: gateway fixture', { tools: [] })
await record('denied-tool-turn', 'Use the Bash tool exactly once to run pwd, then report the denial.', {
  tools: ['Bash'],
  canUseTool: denyTool,
  expectPermissionCallback: true,
})

function sanitize(value: unknown, fixturePaths: string[]): unknown {
  const ids = new Map<string, string>()
  let nextId = 1

  function visit(current: unknown, key?: string): unknown {
    if (typeof current === 'string') {
      let sanitizedPath = current
      for (const fixturePath of fixturePaths) {
        sanitizedPath = sanitizedPath.replaceAll(fixturePath, '<fixture-cwd>')
      }
      sanitizedPath = sanitizedPath.replaceAll(homedir(), '<home>')
      if (key && isIdentifierKey(key)) {
        const existing = ids.get(sanitizedPath)
        if (existing) return existing
        const replacement = `<${key}-${nextId++}>`
        ids.set(sanitizedPath, replacement)
        return replacement
      }
      return sanitizedPath
    }
    if (Array.isArray(current)) return current.map((item) => visit(item))
    if (typeof current === 'object' && current !== null) {
      return Object.fromEntries(Object.entries(current).map(([entryKey, item]) => [entryKey, visit(item, entryKey)]))
    }
    return current
  }

  return visit(value)
}

function isIdentifierKey(key: string): boolean {
  return [
    'id',
    'uuid',
    'session_id',
    'request_id',
    'tool_use_id',
    'parent_tool_use_id',
    'message_id',
  ].includes(key)
}
