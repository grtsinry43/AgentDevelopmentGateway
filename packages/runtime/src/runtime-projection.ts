import {
  cloneTaskState,
  createEmptyTaskState,
  applyTaskStateUpdate,
  type InputAdmissionReceipt,
  type InputQueueEntry,
  type RuntimeEvent,
  type SubagentRun,
  type TaskState,
} from '@agent-gateway/core'

export interface RuntimeInputAdmission {
  clientMessageId: string
  receipt: InputAdmissionReceipt
}

export interface DurableRuntimeProjection {
  taskState: TaskState
  subagentRuns: SubagentRun[]
  inputQueue: InputQueueEntry[]
  inputAdmissions: RuntimeInputAdmission[]
}

/** Rebuilds authoritative durable runtime state from the append-only event stream. */
export function projectDurableRuntimeState(events: readonly RuntimeEvent[]): DurableRuntimeProjection {
  let taskState = createEmptyTaskState()
  let inputQueue: InputQueueEntry[] = []
  const subagentRuns = new Map<SubagentRun['id'], SubagentRun>()
  const inputAdmissions = new Map<string, InputAdmissionReceipt>()

  for (const event of events) {
    if (event.type === 'task.updated') {
      taskState = applyTaskStateUpdate(taskState, event.payload.update)
    } else if (
      event.type === 'subagent.started' ||
      event.type === 'subagent.updated' ||
      event.type === 'subagent.completed'
    ) {
      subagentRuns.set(event.payload.run.id, structuredClone(event.payload.run))
    } else if (event.type === 'input.admitted') {
      const entry = structuredClone(event.payload.entry)
      inputAdmissions.set(entry.id, { admittedSequence: entry.admittedSequence })
      if (!inputQueue.some((candidate) => candidate.id === entry.id)) inputQueue.push(entry)
    } else if (event.type === 'input.queue_updated') {
      inputQueue = event.payload.entries.map((entry) => structuredClone(entry))
    } else if (
      event.type === 'input.dispatched' ||
      event.type === 'input.failed' ||
      event.type === 'input.cancelled'
    ) {
      inputQueue = inputQueue.filter((entry) => entry.id !== event.payload.entry.id)
    }
  }

  return {
    taskState: cloneTaskState(taskState),
    subagentRuns: [...subagentRuns.values()].map((run) => structuredClone(run)),
    inputQueue: inputQueue.map((entry) => structuredClone(entry)),
    inputAdmissions: [...inputAdmissions.entries()].map(([clientMessageId, receipt]) => ({
      clientMessageId,
      receipt: { ...receipt },
    })),
  }
}
