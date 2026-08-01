import { createHash } from 'node:crypto'
import type { TaskItem, TaskStateUpdate, TaskStatus } from '@agent-gateway/core'

export function mapClaudeTaskUpdates(
  toolName: string,
  input: unknown,
  output: unknown,
): TaskStateUpdate[] {
  if (toolName === 'TodoWrite') return mapTodoWrite(input, output)
  if (toolName === 'TaskCreate') return mapTaskCreate(input, output)
  if (toolName === 'TaskUpdate') return mapTaskUpdate(input, output)
  if (toolName === 'TaskList') return mapTaskList(output)
  if (toolName === 'TaskGet') return mapTaskGet(output)
  return []
}

function mapTodoWrite(input: unknown, output: unknown): TaskStateUpdate[] {
  const outputRecord = record(output)
  const inputRecord = record(input)
  const nativeTasks = array(outputRecord?.newTodos) ?? array(inputRecord?.todos)
  if (!nativeTasks) return []

  const occurrences = new Map<string, number>()
  const tasks: TaskItem[] = []
  for (const value of nativeTasks) {
    const task = record(value)
    const title = string(task?.content)
    const status = taskStatus(task?.status)
    if (!title || !status) continue
    const occurrence = occurrences.get(title) ?? 0
    occurrences.set(title, occurrence + 1)
    const activeText = string(task?.activeForm)
    tasks.push({
      id: todoId(title, occurrence),
      title,
      status,
      ...(activeText ? { activeText } : {}),
    })
  }
  return [{ kind: 'replace', tasks }]
}

function mapTaskCreate(input: unknown, output: unknown): TaskStateUpdate[] {
  const nativeInput = record(input)
  const nativeTask = record(record(output)?.task)
  const id = string(nativeTask?.id)
  const title = string(nativeTask?.subject) ?? string(nativeInput?.subject)
  if (!id || !title) return []
  const description = string(nativeInput?.description)
  const activeText = string(nativeInput?.activeForm)
  return [
    {
      kind: 'upsert',
      task: {
        id,
        title,
        status: 'pending',
        ...(description ? { description } : {}),
        ...(activeText ? { activeText } : {}),
      },
    },
  ]
}

function mapTaskUpdate(input: unknown, output: unknown): TaskStateUpdate[] {
  const nativeInput = record(input)
  const nativeOutput = record(output)
  if (nativeOutput?.success !== true) return []
  const id = string(nativeOutput.taskId) ?? string(nativeInput?.taskId)
  if (!id) return []
  if (nativeInput?.status === 'deleted') return [{ kind: 'remove', id }]

  const status = taskStatus(nativeInput?.status)
  const title = string(nativeInput?.subject)
  const description = string(nativeInput?.description)
  const activeText = string(nativeInput?.activeForm)
  const owner = string(nativeInput?.owner)
  const blocks = stringArray(nativeInput?.addBlocks)
  const blockedBy = stringArray(nativeInput?.addBlockedBy)
  const changes = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(activeText ? { activeText } : {}),
    ...(owner ? { owner } : {}),
    ...(status ? { status } : {}),
  }
  const append = {
    ...(blocks ? { blocks } : {}),
    ...(blockedBy ? { blockedBy } : {}),
  }
  if (Object.keys(changes).length === 0 && Object.keys(append).length === 0) return []
  return [
    {
      kind: 'patch',
      id,
      changes,
      ...(Object.keys(append).length > 0 ? { append } : {}),
    },
  ]
}

function mapTaskList(output: unknown): TaskStateUpdate[] {
  const nativeTasks = array(record(output)?.tasks)
  if (!nativeTasks) return []
  const tasks = nativeTasks.flatMap((value): TaskItem[] => {
    const task = record(value)
    const id = string(task?.id)
    const title = string(task?.subject)
    const status = taskStatus(task?.status)
    if (!id || !title || !status) return []
    const owner = string(task?.owner)
    const blockedBy = stringArray(task?.blockedBy)
    return [
      {
        id,
        title,
        status,
        ...(owner ? { owner } : {}),
        ...(blockedBy ? { blockedBy } : {}),
      },
    ]
  })
  return [{ kind: 'replace', tasks }]
}

function mapTaskGet(output: unknown): TaskStateUpdate[] {
  const task = record(record(output)?.task)
  const id = string(task?.id)
  const title = string(task?.subject)
  const status = taskStatus(task?.status)
  if (!id || !title || !status) return []
  const description = string(task?.description)
  const blocks = stringArray(task?.blocks)
  const blockedBy = stringArray(task?.blockedBy)
  return [
    {
      kind: 'upsert',
      task: {
        id,
        title,
        status,
        ...(description ? { description } : {}),
        ...(blocks ? { blocks } : {}),
        ...(blockedBy ? { blockedBy } : {}),
      },
    },
  ]
}

function todoId(title: string, occurrence: number): string {
  const digest = createHash('sha256').update(title).digest('hex').slice(0, 16)
  return `todo:${digest}:${occurrence}`
}

function taskStatus(value: unknown): TaskStatus | undefined {
  return value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'cancelled'
    ? value
    : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined
  return [...new Set(value.filter((entry) => entry.length > 0))]
}
