import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SlashCommand } from '@agent-gateway/core'

const BUILTIN_COMMANDS: Array<[string, string, string?]> = [
  ['help', 'Show help for all slash commands', ''],
  ['clear', 'Start a new conversation', ''],
  ['compact', 'Compact the conversation history', ''],
  ['config', 'View and edit configuration', ''],
  ['cost', 'View the total cost of the current conversation', ''],
  ['model', 'Switch the model used by Claude Code', '[model-name]'],
  ['login', 'Log in to your Claude account', ''],
  ['logout', 'Log out of your Claude account', ''],
  ['status', 'Show the status of your Claude Code installation', ''],
  ['resume', 'Resume a previous conversation', ''],
  ['usage', 'Check the current usage limits', ''],
  ['mcp', 'Manage MCP servers', ''],
  ['permissions', 'View and adjust permissions', ''],
  ['memory', 'View and manage memory', ''],
]

function frontmatterField(content: string, key: string): string | undefined {
  const line = content.split('\n').find((item) => item.trim().startsWith(key + ':'))
  if (!line) return undefined
  const value = line.slice(line.indexOf(':') + 1).trim()
  return value ? value.replace(/^['"]|['"]$/g, '').trim() : undefined
}

function readMeta(file: string): { description?: string; argumentHint?: string } | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  return {
    description: frontmatterField(content, 'description'),
    argumentHint: frontmatterField(content, 'argument-hint'),
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 从用户目录 + 项目目录收集命令与技能,返回按 kind 分类的统一模型。
 * - .claude/commands 下的 .md -> kind command
 * - .claude/skills 下的 SKILL.md -> kind skill
 * - 内置命令 -> kind command, source builtin
 */
export function listClaudeCommands(projectPath: string): SlashCommand[] {
  const result: SlashCommand[] = []
  const userClaude = join(homedir(), '.claude')

  const roots = [join(projectPath, '.claude'), userClaude]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const source = root === userClaude ? ('user' as const) : ('project' as const)

    for (const entry of listFiles(join(root, 'commands'))) {
      if (!entry.endsWith('.md')) continue
      const name = entry.slice(0, -3)
      const meta = readMeta(join(root, 'commands', entry))
      result.push({
        name,
        description: meta?.description ?? name,
        argumentHint: meta?.argumentHint,
        kind: 'command',
        source,
        invoke: '/' + name,
      })
    }

    for (const entry of listFiles(join(root, 'skills'))) {
      if (entry.startsWith('.')) continue
      const meta = readMeta(join(root, 'skills', entry, 'SKILL.md'))
      if (!meta) continue
      result.push({
        name: entry,
        description: meta.description ?? entry,
        kind: 'skill',
        source,
        invoke: '/' + entry,
      })
    }
  }

  for (const [name, description, argumentHint] of BUILTIN_COMMANDS) {
    result.push({
      name,
      description,
      argumentHint,
      kind: 'command',
      source: 'builtin',
      invoke: '/' + name,
    })
  }

  return result
}
