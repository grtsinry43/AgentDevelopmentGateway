import type { ToolKind } from '@agent-gateway/core'

/** Classify Claude-native tool names into the provider-neutral UI vocabulary. */
export function classifyClaudeTool(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp'

  switch (name) {
    case 'Bash':
      return 'terminal'
    case 'Read':
      return 'file-read'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return 'file-edit'
    case 'Glob':
    case 'Grep':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Agent':
    case 'Task':
      return 'subagent'
    case 'TaskCreate':
    case 'TaskGet':
    case 'TaskList':
    case 'TaskUpdate':
      return 'task-control'
    case 'TodoWrite':
      return 'todo'
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'plan'
    case 'EnterWorktree':
    case 'ExitWorktree':
      return 'worktree'
    default:
      return 'generic'
  }
}
