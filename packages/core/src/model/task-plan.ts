/**
 * Task / Plan model (§9.4). Converges Claude TodoWrite + plan mode, Codex
 * `todo_list` item + `turn/plan/updated`, and OpenCode todo parts.
 *
 * `TaskItem` = a checklist entry with optional graph metadata; `Plan`/`PlanStep` = an
 * ordered plan document (plan mode).
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TaskPriority = 'high' | 'medium' | 'low'

export interface TaskItem {
  id: string
  title: string
  status: TaskStatus
  description?: string
  activeText?: string
  priority?: TaskPriority
  owner?: string
  /** Task ids this task prevents from starting. */
  blocks?: string[]
  /** Task ids that must finish before this task can start. */
  blockedBy?: string[]
}

export interface TaskState {
  tasks: TaskItem[]
  /** Optional provider-authored reason for replacing the current checklist. */
  explanation?: string
}

export type TaskItemPatch = Partial<
  Pick<TaskItem, 'title' | 'status' | 'description' | 'activeText' | 'priority' | 'owner'>
>

export interface TaskRelationsAppend {
  blocks?: string[]
  blockedBy?: string[]
}

export type TaskStateUpdate =
  | { kind: 'replace'; tasks: TaskItem[]; explanation?: string }
  | { kind: 'upsert'; task: TaskItem }
  | { kind: 'patch'; id: string; changes: TaskItemPatch; append?: TaskRelationsAppend }
  | { kind: 'remove'; id: string }

export function createEmptyTaskState(): TaskState {
  return { tasks: [] }
}

export function cloneTaskState(state: TaskState): TaskState {
  return {
    tasks: state.tasks.map(cloneTaskItem),
    ...(state.explanation === undefined ? {} : { explanation: state.explanation }),
  }
}

/** Pure provider-neutral reducer shared by the authoritative Runtime and client projections. */
export function applyTaskStateUpdate(current: TaskState, update: TaskStateUpdate): TaskState {
  if (update.kind === 'replace') {
    return {
      tasks: update.tasks.map(cloneTaskItem),
      ...(update.explanation === undefined ? {} : { explanation: update.explanation }),
    }
  }
  if (update.kind === 'remove') {
    return { ...current, tasks: current.tasks.filter((task) => task.id !== update.id) }
  }
  if (update.kind === 'upsert') {
    const index = current.tasks.findIndex((task) => task.id === update.task.id)
    const task = cloneTaskItem(update.task)
    if (index < 0) return { ...current, tasks: [...current.tasks, task] }
    return {
      ...current,
      tasks: current.tasks.map((entry, entryIndex) => (entryIndex === index ? task : entry)),
    }
  }

  const index = current.tasks.findIndex((task) => task.id === update.id)
  if (index < 0) return current
  return {
    ...current,
    tasks: current.tasks.map((task, taskIndex) => {
      if (taskIndex !== index) return task
      return {
        ...task,
        ...update.changes,
        ...(update.append?.blocks
          ? { blocks: appendUnique(task.blocks, update.append.blocks) }
          : {}),
        ...(update.append?.blockedBy
          ? { blockedBy: appendUnique(task.blockedBy, update.append.blockedBy) }
          : {}),
      }
    }),
  }
}

function cloneTaskItem(task: TaskItem): TaskItem {
  return {
    ...task,
    ...(task.blocks ? { blocks: [...task.blocks] } : {}),
    ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
  }
}

function appendUnique(current: string[] | undefined, added: string[]): string[] {
  return [...new Set([...(current ?? []), ...added])]
}

export interface PlanStep {
  id: string
  text: string
  status: TaskStatus
}

export interface Plan {
  id: string
  steps: PlanStep[]
}
