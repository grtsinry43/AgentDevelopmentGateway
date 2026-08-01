import { asSessionId, type AgentSession, type RuntimeCapabilities } from '@agent-gateway/core'
import {
  runtimeCapabilitiesSchema,
  sessionExecutionStateSchema,
} from '@agent-gateway/shared'
import { z } from 'zod'
import type { GatewayDatabase } from '../../infrastructure/database.js'

const sessionRowSchema = z.strictObject({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  host_id: z.string().uuid(),
  adapter_id: z.enum(['claude-code', 'codex', 'opencode']),
  runtime_session_id: z.string().nullable(),
  provider_profile_id: z.string().nullable(),
  model: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
  mode: z.enum(['default', 'plan']).nullable(),
  work_mode: z.enum(['build', 'plan']),
  execution_settings_json: z.string(),
  effective_execution_settings_json: z.string(),
  execution_limitations_json: z.string(),
  capabilities_json: z.string(),
  control_revision: z.number().int().nonnegative(),
  status: z.enum(['starting', 'idle', 'running', 'waiting', 'interrupted', 'error', 'closed']),
  title: z.string().nullable(),
  last_event_sequence: z.number().int().nonnegative(),
  provider_state_snapshot: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative()
})

export interface StoredSession {
  session: AgentSession
  capabilities: RuntimeCapabilities
}

const activeStatuses = ['starting', 'idle', 'running', 'waiting'] as const

export class SessionRepository {
  constructor(private readonly database: GatewayDatabase) {}

  create(stored: StoredSession): void {
    const { session } = stored
    this.database
      .prepare(
        `INSERT INTO sessions (
          id, project_id, adapter_id, runtime_session_id, provider_profile_id,
          model, reasoning_effort, mode, status, title, last_event_sequence,
          provider_state_snapshot, created_at, updated_at, work_mode,
          execution_settings_json, effective_execution_settings_json,
          execution_limitations_json, capabilities_json, control_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.projectId,
        session.adapterId,
        session.runtimeSessionId ?? null,
        session.providerProfileId ?? null,
        session.model?.model ?? null,
        session.model?.reasoningEffort ?? null,
        session.execution.configured.workMode === 'plan' ? 'plan' : null,
        session.status,
        session.title ?? null,
        session.lastEventSequence,
        session.providerStateSnapshot ?? null,
        session.createdAt,
        session.updatedAt
        ,session.execution.configured.workMode,
        JSON.stringify(session.execution.configured),
        JSON.stringify(session.execution.effective),
        JSON.stringify(session.execution.limitations),
        JSON.stringify(stored.capabilities),
        session.controlRevision
      )
  }

  updateSnapshot(session: AgentSession, capabilities?: RuntimeCapabilities): void {
    this.database
      .prepare(
        `UPDATE sessions SET
          runtime_session_id = ?, provider_profile_id = ?, model = ?, reasoning_effort = ?,
          status = ?, title = ?, last_event_sequence = ?, provider_state_snapshot = ?,
          updated_at = ?, work_mode = ?, execution_settings_json = ?,
          effective_execution_settings_json = ?, execution_limitations_json = ?,
          capabilities_json = COALESCE(?, capabilities_json), control_revision = ?
         WHERE id = ?`
      )
      .run(
        session.runtimeSessionId ?? null,
        session.providerProfileId ?? null,
        session.model?.model ?? null,
        session.model?.reasoningEffort ?? null,
        session.status,
        session.title ?? null,
        session.lastEventSequence,
        session.providerStateSnapshot ?? null,
        session.updatedAt,
        session.execution.configured.workMode,
        JSON.stringify(session.execution.configured),
        JSON.stringify(session.execution.effective),
        JSON.stringify(session.execution.limitations),
        capabilities ? JSON.stringify(capabilities) : null,
        session.controlRevision,
        session.id
      )
  }

  findById(id: string): StoredSession | undefined {
    const row = this.database.prepare(sessionSelect('WHERE sessions.id = ?')).get(id)
    return row === undefined ? undefined : mapSession(row)
  }

  listByProject(projectId: string): StoredSession[] {
    return this.database
      .prepare(sessionSelect('WHERE sessions.project_id = ? ORDER BY sessions.updated_at DESC'))
      .all(projectId)
      .map(mapSession)
  }

  delete(id: string): void {
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  hasActiveForProject(projectId: string): boolean {
    const placeholders = activeStatuses.map(() => '?').join(', ')
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM sessions
         WHERE project_id = ? AND status IN (${placeholders}) LIMIT 1`
      )
      .get(projectId, ...activeStatuses)
    return row !== undefined
  }

  interruptActive(): number {
    const placeholders = activeStatuses.map(() => '?').join(', ')
    return this.database
      .prepare(
        `UPDATE sessions SET status = 'interrupted', updated_at = ?
         WHERE status IN (${placeholders})`
      )
      .run(Date.now(), ...activeStatuses).changes
  }

  interruptByIds(ids: string[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    this.database
      .prepare(
        `UPDATE sessions SET status = 'interrupted', updated_at = ?
         WHERE id IN (${placeholders})`
      )
      .run(Date.now(), ...ids)
  }
}

function sessionSelect(suffix: string): string {
  return `SELECT
    sessions.id, sessions.project_id, projects.host_id, sessions.adapter_id,
    sessions.runtime_session_id, sessions.provider_profile_id, sessions.model,
    sessions.reasoning_effort, sessions.mode, sessions.work_mode,
    sessions.execution_settings_json, sessions.effective_execution_settings_json,
    sessions.execution_limitations_json, sessions.capabilities_json,
    sessions.control_revision, sessions.status, sessions.title,
    sessions.last_event_sequence, sessions.provider_state_snapshot,
    sessions.created_at, sessions.updated_at
  FROM sessions
  JOIN projects ON projects.id = sessions.project_id
  ${suffix}`
}

function mapSession(row: unknown): StoredSession {
  const parsed = sessionRowSchema.parse(row)
  const execution = sessionExecutionStateSchema.parse({
    configured: parseJson(parsed.execution_settings_json, 'configured execution settings'),
    effective: parseJson(parsed.effective_execution_settings_json, 'effective execution settings'),
    limitations: parseJson(parsed.execution_limitations_json, 'execution limitations'),
  })
  const capabilities = runtimeCapabilitiesSchema.parse(
    parseJson(parsed.capabilities_json, 'runtime capabilities')
  )
  return {
    session: {
      id: asSessionId(parsed.id),
      projectId: parsed.project_id,
      hostId: parsed.host_id,
      adapterId: parsed.adapter_id,
      ...(parsed.runtime_session_id === null
        ? {}
        : { runtimeSessionId: parsed.runtime_session_id }),
      ...(parsed.provider_profile_id === null
        ? {}
        : { providerProfileId: parsed.provider_profile_id }),
      ...(parsed.model === null
        ? {}
        : {
            model: {
              model: parsed.model,
              ...(parsed.reasoning_effort === null
                ? {}
                : { reasoningEffort: parsed.reasoning_effort })
            }
          }),
      execution,
      controlRevision: parsed.control_revision,
      status: parsed.status,
      ...(parsed.title === null ? {} : { title: parsed.title }),
      ...(parsed.provider_state_snapshot === null
        ? {}
        : { providerStateSnapshot: parsed.provider_state_snapshot }),
      lastEventSequence: parsed.last_event_sequence,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at
    },
    capabilities
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`Stored ${label} is invalid JSON`, { cause: error })
  }
}
