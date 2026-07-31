/**
 * Task / Plan model (§9.4). Converges Claude TodoWrite + plan mode, Codex
 * `todo_list` item + `turn/plan/updated`, and OpenCode todo parts.
 *
 * `TaskItem` = a flat todo list entry; `Plan`/`PlanStep` = an ordered plan (plan mode).
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskItem {
  id: string
  text: string
  status: TaskStatus
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
