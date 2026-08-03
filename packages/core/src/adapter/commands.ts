/**
 * Slash 命令/技能统一模型 —— 抹平三家 provider 的差异。
 *
 * 三家对「命令 vs 技能」的划分不同:Claude 已把 `.claude/commands/` 和
 * `.claude/skills/` 合并成一个 `/` 触发的 slash 列表;Codex 的 catalog 全是 skills
 * (`$` 触发);OpenCode 用 `command.list` + `skill.list` 分开(带 `slash` 标志)。
 * 这里统一成 `kind`,由 adapter 负责分类。
 *
 * 执行语义统一为「发前缀文本」:claude/opencode 发 `/name`,codex 的 skill 发
 * `$name`,provider 自己按渐进披露加载内容(客户端不读 SKILL.md 注入)。
 */
export type SlashCommandKind = 'command' | 'skill'
export type SlashCommandSource = 'builtin' | 'project' | 'user'

export interface SlashCommand {
  /** 不带前缀的名字,如 `clear`。 */
  name: string
  description: string
  /** 参数提示,如 `<file>`(Claude)。 */
  argumentHint?: string
  /** 命令还是技能;adapter 负责分类(Claude 靠磁盘目录、Codex 全技能、OpenCode 天然分)。 */
  kind: SlashCommandKind
  source?: SlashCommandSource
  /**
   * 统一触发前缀:`/name`(命令)或 `$name`(技能)。这是我们的约定,不是发给
   * provider 的原文 —— adapter 执行时会翻译成 provider 实际语义
   * (claude 的 skill 也是 `/`,codex 的 skill 是 `$`)。
   */
  invoke: string
}

import type { RuntimeConnection } from './connection.js'
import type { SessionId } from '../ids.js'

/** 与 `ListModelsInput` 对齐:项目路径 + 连接(可能无会话,如 claude 磁盘解析)。 */
export interface ListCommandsInput {
  projectPath: string
  connection?: RuntimeConnection
  sessionId?: SessionId
}

export type { RuntimeConnection } from './connection.js'
