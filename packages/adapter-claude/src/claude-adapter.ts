import { randomUUID } from 'node:crypto'
import {
  AdapterError,
  cloneSessionExecutionSettings,
  createDefaultSessionExecutionSettings,
  toRuntimeError,
  type AdapterEvent,
  type CreateSessionInput,
  type InteractionResolution,
  type InterruptOptions,
  type ListModelsInput,
  type ListCommandsInput,
  type ModelCatalog,
  type ModelSelection,
  type SlashCommand,
  type ProviderRuntimeConfig,
  type ExecutionConfigurationResult,
  type ResumeSessionInput,
  type RuntimeAdapter,
  type RuntimeAdapterDescriptor,
  type RuntimeCapabilities,
  type RuntimeConnectOptions,
  type RuntimeConnection,
  type RuntimeHostContext,
  type RuntimeInstallation,
  type RuntimeSessionHandle,
  type SendOptions,
  type SessionId,
  type SessionExecutionSettings,
  type SessionExecutionState,
  type TurnId,
  type UserInput,
  type RewindSessionInput,
  type RewindSessionResult,
  type RewindFileDiff,
  type RewindTarget,
} from '@agent-gateway/core'
import {
  query as createClaudeQuery,
  renameSession as claudeRenameSession,
  getSessionInfo as claudeGetSessionInfo,
  getSessionMessages as claudeGetSessionMessages,
  createSdkMcpServer,
  tool as defineMcpTool,
  type ModelInfo,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { AsyncQueue } from './async-queue.js'
import { CLAUDE_BASE_CAPABILITIES } from './capabilities.js'
import { listClaudeCommands } from './commands.js'
import { ClaudeInteractionBridge } from './interaction-bridge.js'
import { mapSessionContext } from './input.js'
import { ClaudeMessageMapper } from './message-mapper.js'
import { createClaudePreToolUseHook, resolveClaudeExecution } from './execution-policy.js'

export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  initializationResult(): Promise<SDKControlInitializeResponse>
  supportedModels(): Promise<ModelInfo[]>
  supportedCommands(): Promise<import('@anthropic-ai/claude-agent-sdk').SlashCommand[]>
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<unknown>
  applyFlagSettings(settings: {
    model?: string | null
    effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  }): Promise<unknown>
  setPermissionMode(mode: import('@anthropic-ai/claude-agent-sdk').PermissionMode): Promise<unknown>
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<import('@anthropic-ai/claude-agent-sdk').RewindFilesResult>
  close(): void
}

export type ClaudeQueryFactory = (parameters: Parameters<typeof createClaudeQuery>[0]) => ClaudeQuery

export type ClaudeSessionMessagesFetcher = typeof claudeGetSessionMessages

interface ClaudeConnectionState {
  connection: RuntimeConnection
  context: RuntimeHostContext
  installation?: RuntimeInstallation
}

interface ClaudeSessionState {
  id: SessionId
  runtimeSessionId: string
  projectPath: string
  query: ClaudeQuery
  input: AsyncQueue<SDKUserMessage>
  events: AsyncQueue<AdapterEvent>
  mapper: ClaudeMessageMapper
  bridge: ClaudeInteractionBridge
  capabilities: RuntimeCapabilities
  execution: SessionExecutionState
  /** Provider credentials/relay/aliases this session was created with (alias mapping). */
  providerConfig?: ProviderRuntimeConfig
  activeTurnId?: TurnId
  lastTurnId?: TurnId
  /** Last provider-generated title we published, to dedupe `title_changed` events. */
  providerTitle?: string
  /** 已发送的用户输入(等待 provider echo 关联 uuid):clientMessageId → text。 */
  pendingUserInputs: { clientMessageId: string; text: string }[]
  /** clientMessageId → provider 用户消息 uuid(rewindFiles 定位用)。 */
  providerUserMessages: Map<string, string>
  /** 文本 → provider 用户消息 uuid:live 与 resume 重放都会填,resume 后兜底解析。 */
  userMessageUuidsByText: Map<string, string>
  disposed: boolean
  failure?: unknown
  pump: Promise<void>
}

const descriptor: RuntimeAdapterDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  adapterVersion: '0.0.0',
  protocolVersion: '1',
  capabilities: CLAUDE_BASE_CAPABILITIES,
}

/** Claude Agent SDK adapter backed by one streaming-input Query per Gateway session. */
export class ClaudeAdapter implements RuntimeAdapter {
  readonly descriptor = descriptor
  private readonly connections = new Map<string, ClaudeConnectionState>()
  private readonly sessions = new Map<SessionId, ClaudeSessionState>()

  constructor(
    private readonly queryFactory: ClaudeQueryFactory = createClaudeQuery,
    private readonly fetchSessionMessages: ClaudeSessionMessagesFetcher = claudeGetSessionMessages,
  ) {}

  detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]> {
    void context
    return Promise.resolve([
      {
        path: '@anthropic-ai/claude-agent-sdk',
        source: 'managed',
      },
    ])
  }

  connect(options: RuntimeConnectOptions): Promise<RuntimeConnection> {
    const connection: RuntimeConnection = {
      id: randomUUID(),
      transport: 'sdk',
      runtimeVersion: options.installation?.version,
      capabilities: cloneCapabilities(CLAUDE_BASE_CAPABILITIES),
    }
    this.connections.set(connection.id, {
      connection,
      context: options.context,
      installation: options.installation,
    })
    return Promise.resolve(connection)
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    const runtimeSessionId = randomUUID()
    const session = await this.startSession({
      id: input.sessionId,
      runtimeSessionId,
      projectPath: input.projectPath,
      connection: input.connection,
      providerProfileId: input.providerProfileId,
      providerConfig: input.providerConfig,
      model: input.model,
      execution: input.execution,
      systemPromptAppend: mapSessionContext(input.context),
      querySessionOptions: { sessionId: runtimeSessionId },
      publishCreated: true,
    })
    return {
      sessionId: session.id,
      runtimeSessionId: session.runtimeSessionId,
      execution: executionResult(session.execution),
    }
  }

  async resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle> {
    if (input.providerStateSnapshot) {
      throw adapterError('protocol', 'Claude sessions do not resume from provider state snapshots')
    }
    if (input.cursor && input.cursor.by !== 'message') {
      throw adapterError('protocol', `Claude cannot resume from a ${input.cursor.by} cursor`)
    }
    const session = await this.startSession({
      id: input.sessionId,
      runtimeSessionId: input.runtimeSessionId,
      projectPath: input.projectPath,
      connection: input.connection,
      model: input.model,
      execution: input.execution,
      systemPromptAppend: mapSessionContext(input.context),
      querySessionOptions: {
        resume: input.runtimeSessionId,
        ...(input.cursor?.by === 'message' ? { resumeSessionAt: input.cursor.messageUuid } : {}),
      },
      publishCreated: false,
    })
    return {
      sessionId: session.id,
      runtimeSessionId: session.runtimeSessionId,
      execution: executionResult(session.execution),
    }
  }

  send(sessionId: SessionId, input: UserInput, options: SendOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (options.context) {
      throw adapterError('not_implemented', 'Claude turn context injection is not implemented')
    }
    if (input.admitOnly) throw adapterError('protocol', 'admitOnly inputs must not be delivered to adapters')
    if (input.attachments?.length) {
      throw adapterError('not_implemented', 'Claude attachment delivery is not implemented')
    }
    if (session.activeTurnId) {
      throw adapterError('protocol', `Claude session already has an active turn: ${session.activeTurnId}`)
    }

    session.activeTurnId = options.turnId
    session.lastTurnId = options.turnId
    session.pendingUserInputs.push({ clientMessageId: input.clientMessageId, text: input.text })
    try {
      session.input.push({
        type: 'user',
        message: { role: 'user', content: input.text },
        parent_tool_use_id: null,
      })
    } catch (error) {
      session.activeTurnId = undefined
      throw error
    }
    this.publish(session, {
      type: 'turn.started',
      payload: { turnId: options.turnId },
      turnId: options.turnId,
    })
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'running' },
      turnId: options.turnId,
    })
    return Promise.resolve()
  }

  async interrupt(sessionId: SessionId, options?: InterruptOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (options?.cancelQueued) {
      throw adapterError('not_implemented', 'Claude Agent SDK does not expose cancelQueued on Query.interrupt()')
    }
    if (options?.turnId && options.turnId !== session.activeTurnId) {
      throw adapterError('protocol', `Claude active turn is ${session.activeTurnId ?? 'none'}, not ${options.turnId}`)
    }
    if (options?.expectedTurnId && options.expectedTurnId !== session.activeTurnId) {
      throw adapterError(
        'protocol',
        `Claude active turn is ${session.activeTurnId ?? 'none'}, not expected ${options.expectedTurnId}`,
      )
    }
    const interruptedTurnId = session.activeTurnId
    if (!interruptedTurnId) return // 幂等:没有活跃回合就不需要中断
    session.bridge.cancelAll('aborted', 'Turn interrupted')
    await session.query.interrupt()
    // 回合已停:清掉 activeTurnId,同一 query 可直接开新回合(无需 resume)。
    session.activeTurnId = undefined
    this.publish(session, {
      type: 'turn.completed',
      payload: { turnId: interruptedTurnId, status: 'interrupted' },
      turnId: interruptedTurnId,
    })
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'interrupted' },
      turnId: interruptedTurnId,
    })
  }

  resolveInteraction(sessionId: SessionId, resolution: InteractionResolution): Promise<void> {
    this.getSession(sessionId).bridge.resolve(resolution)
    return Promise.resolve()
  }

  /**
   * 原生回退(CC `/rewind` 的文件侧):解析目标用户消息的 provider uuid,调
   * `Query.rewindFiles`。preview 走 dryRun 返回文件 diff;apply 真正还原文件。
   * uuid 解析:内存索引(live echo / resume 重放)优先,兜底 `getSessionMessages` 按文本拉取。
   */
  async rewindSession(input: RewindSessionInput): Promise<RewindSessionResult> {
    const session = this.getSession(input.sessionId)
    if (input.target.by !== 'message') {
      throw adapterError('protocol', 'Claude rewind requires a message target')
    }
    const userMessageId = await this.resolveRewindUserMessageId(session, input.target)
    if (!userMessageId) {
      throw adapterError('protocol', `Claude cannot resolve rewind target ${input.target.messageUuid}`)
    }
    const result = await session.query.rewindFiles(userMessageId, {
      dryRun: input.mode === 'preview',
    })
    if (!result.canRewind) {
      throw adapterError('protocol', result.error ?? 'Claude cannot rewind to this point')
    }
    const files = result.filesChanged ?? []
    const fileDiff: RewindFileDiff[] = files.map((file) => ({
      file,
      insertions: result.insertions ?? 0,
      deletions: result.deletions ?? 0,
    }))
    return {
      strategy: 'native',
      removedMessageCount: 0,
      fileDiff,
      available: { native: true, fork: false },
      ...(input.mode === 'apply' ? { filesReverted: true } : {}),
    }
  }

  /** 解析目标用户消息的 provider uuid:内存索引优先,SDK 会话消息按文本兜底。 */
  private async resolveRewindUserMessageId(
    session: ClaudeSessionState,
    target: RewindTarget,
  ): Promise<string | undefined> {
    if (target.clientMessageId) {
      const indexed = session.providerUserMessages.get(target.clientMessageId)
      if (indexed) return indexed
    }
    if (target.text) {
      const byText = session.userMessageUuidsByText.get(target.text.trim())
      if (byText) return byText
      try {
        const messages = await this.fetchSessionMessages(session.runtimeSessionId, {
          dir: session.projectPath,
        })
        for (const message of messages) {
          if (message.type !== 'user') continue
          const text = claudeSessionMessageText(message.message)
          if (text.trim() === target.text.trim()) return message.uuid
        }
      } catch {
        // 拉不到会话消息时继续走下面的失败路径。
      }
    }
    return undefined
  }

  async listModels(input: ListModelsInput): Promise<ModelCatalog> {
    if (input.sessionId) {
      const models = await this.getSession(input.sessionId).query.supportedModels()
      return { models: models.map(mapModelInfo) }
    }

    const connection = this.getConnection(input.connection)
    const prompt = new AsyncQueue<SDKUserMessage>()
    const query = this.queryFactory({
      prompt,
      options: {
        cwd: input.projectPath,
        persistSession: false,
        settingSources: ['user', 'project', 'local'],
        env: { ...process.env, ...connection.context.env },
        pathToClaudeCodeExecutable:
          connection.installation?.source === 'path' || connection.installation?.source === 'custom'
            ? connection.installation.path
            : undefined,
      },
    })
    try {
      const models = await query.supportedModels()
      return { models: models.map(mapModelInfo) }
    } finally {
      prompt.close()
      query.close()
    }
  }

  async setModel(sessionId: SessionId, model: ModelSelection): Promise<void> {
    const session = this.getSession(sessionId)
    await session.query.applyFlagSettings({
      model: resolveClaudeModel(model.model, session.providerConfig),
      effortLevel: model.reasoningEffort ? mapEffort(model.reasoningEffort) : null,
    })
  }

  /**
   * 拉取 slash 命令/技能目录:读 `.claude/commands` + `.claude/skills` + 内置,按 kind 分类。
   * 有活动会话时用 SDK `supportedCommands()` 拿权威全集并按磁盘目录补充分类。
   */
  async listCommands(input: ListCommandsInput): Promise<SlashCommand[]> {
    const fromDisk = listClaudeCommands(input.projectPath)
    const sessionId = input.sessionId
    if (!sessionId) return fromDisk
    const session = this.sessions.get(sessionId)
    if (!session) return fromDisk
    try {
      const supported = await session.query.supportedCommands()
      if (!supported.length) return fromDisk
      const byName = new Map(fromDisk.map((command) => [command.name, command]))
      return supported.map((command) => {
        const known = byName.get(command.name)
        return {
          name: command.name,
          description: known?.description ?? command.description,
          ...(command.argumentHint
            ? { argumentHint: command.argumentHint }
            : known?.argumentHint
              ? { argumentHint: known.argumentHint }
              : {}),
          kind: known?.kind ?? 'command',
          source: known?.source ?? 'builtin',
          invoke: `/${command.name}`,
        }
      })
    } catch {
      return fromDisk
    }
  }

  async renameSession(sessionId: SessionId, title: string): Promise<void> {
    const session = this.getSession(sessionId)
    // Appends a custom-title entry to the session's JSONL, persisted on the provider side.
    await claudeRenameSession(session.runtimeSessionId, title, { dir: session.projectPath })
  }

  async configureExecution(
    sessionId: SessionId,
    settings: SessionExecutionSettings,
  ): Promise<ExecutionConfigurationResult> {
    const session = this.getSession(sessionId)
    const configured = cloneSessionExecutionSettings(settings)
    const resolved = resolveClaudeExecution(configured)
    await session.query.setPermissionMode(resolved.permissionMode)
    session.execution = {
      configured,
      effective: cloneSessionExecutionSettings(resolved.effective),
      limitations: resolved.limitations.map((limitation) => ({ ...limitation })),
    }
    return {
      effective: cloneSessionExecutionSettings(resolved.effective),
      limitations: resolved.limitations.map((limitation) => ({ ...limitation })),
    }
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    session.bridge.cancelAll('aborted', 'Session disposed')
    session.disposed = true
    session.input.close()
    session.query.close()
    await session.pump.catch(() => undefined)
    if (!session.failure) {
      session.events.push({
        type: 'session.status_changed',
        payload: { status: 'closed' },
        turnId: session.activeTurnId,
      })
    }
    session.events.close()
    this.sessions.delete(sessionId)
  }

  events(sessionId: SessionId): AsyncIterable<AdapterEvent> {
    return this.getSession(sessionId).events
  }

  getCapabilities(sessionId: SessionId): Promise<RuntimeCapabilities> {
    return Promise.resolve(cloneCapabilities(this.getSession(sessionId).capabilities))
  }

  private async startSession(input: {
    id: SessionId
    runtimeSessionId: string
    projectPath: string
    connection: RuntimeConnection
    providerProfileId?: string
    providerConfig?: ProviderRuntimeConfig
    model?: ModelSelection
    execution?: SessionExecutionSettings
    systemPromptAppend?: string
    querySessionOptions: { sessionId: string } | { resume: string; resumeSessionAt?: string }
    publishCreated: boolean
  }): Promise<ClaudeSessionState> {
    if (this.sessions.has(input.id)) throw adapterError('protocol', `Duplicate Gateway session: ${input.id}`)
    const connection = this.getConnection(input.connection)
    const events = new AsyncQueue<AdapterEvent>()
    const sdkInput = new AsyncQueue<SDKUserMessage>()
    const sessionReference: { current?: ClaudeSessionState } = {}
    const configuredExecution = cloneSessionExecutionSettings(
      input.execution ?? createDefaultSessionExecutionSettings(),
    )
    const resolvedExecution = resolveClaudeExecution(configuredExecution)
    const bridge = new ClaudeInteractionBridge(
      input.id,
      () => sessionReference.current?.activeTurnId,
      (event) => {
        if (!sessionReference.current) {
          throw new Error('Claude session received an interaction before construction')
        }
        this.publish(sessionReference.current, event)
      },
      input.projectPath,
    )
    const resolvedModelId = resolveClaudeModel(input.model?.model, input.providerConfig)
    const query = this.queryFactory({
      prompt: sdkInput,
      options: {
        cwd: input.projectPath,
        persistSession: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        // With an injected provider profile the profile's base URL / credentials must be
        // authoritative: Claude Code applies ~/.claude/settings.json env on top of the
        // process env, so a host CC Switch config would silently override the injection.
        settingSources: input.providerConfig
          ? ['project', 'local']
          : ['user', 'project', 'local'],
        env: claudeQueryEnv(connection.context.env, input.providerConfig),
        canUseTool: bridge.canUseTool,
        permissionMode: resolvedExecution.permissionMode,
        // File checkpointing powers `/rewind`: without it Query.rewindFiles has nothing to restore.
        enableFileCheckpointing: true,
        // The SDK gate must be enabled when the Query is created so a later, explicit
        // unrestricted+allow update can enter bypass mode without restarting the session.
        // resolveClaudeExecution is the only place that can actually select bypassPermissions.
        allowDangerouslySkipPermissions: true,
        // In-process MCP server exposing the `preview` tool (JetBrains Air-style): the
        // agent starts a localhost server, then calls `preview` with the port to display
        // it in the Gateway's right preview panel. The handler publishes a
        // `gateway.preview.open` extension event routed back to the desktop.
        mcpServers: {
          'gateway-preview': createSdkMcpServer({
            name: 'gateway-preview',
            version: '0.0.0',
            alwaysLoad: true,
            tools: [
              defineMcpTool(
                'preview',
                'Open a local web server in the Agent Development Gateway preview panel. Call this after starting a localhost web server (e.g. `npm run dev`, `python3 -m http.server 8000`) so the user can see it. Pass the port the server listens on, and the path the page is served at when it is not the root (for example Vite/Next apps often serve at `/` — then omit it; if the entry is `/docs` or `/app`, pass that). The preview is opened at http://localhost:<port><path>.',
                {
                  port: z.number().int().positive(),
                  path: z
                    .string()
                    .optional()
                    .describe('Path on the dev server, starting with `/`, omitted for the root.'),
                },
                async ({ port, path }) => {
                  const current = sessionReference.current
                  if (!current) throw new Error('Gateway session is not ready')
                  this.publish(current, {
                    type: 'runtime.extension',
                    payload: {
                      feature: 'gateway.preview.open',
                      payload: { port, ...(path ? { path } : {}) },
                    },
                  })
                  const location = path ? `http://localhost:${port}${path}` : `http://localhost:${port}`
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: `Preview opened for ${location}`,
                      },
                    ],
                  }
                },
              ),
            ],
          }),
        },
        ...(input.systemPromptAppend
          ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: input.systemPromptAppend,
              },
            }
          : {}),
        hooks: {
          PreToolUse: [
            {
              hooks: [
                createClaudePreToolUseHook(
                  () =>
                    sessionReference.current?.execution.configured ?? configuredExecution,
                  input.projectPath,
                ),
              ],
            },
          ],
        },
        model: resolvedModelId,
        effort: mapEffort(input.model?.reasoningEffort),
        pathToClaudeCodeExecutable:
          connection.installation?.source === 'path' || connection.installation?.source === 'custom'
            ? connection.installation.path
            : undefined,
        ...input.querySessionOptions,
      },
    })
    const session: ClaudeSessionState = {
      id: input.id,
      runtimeSessionId: input.runtimeSessionId,
      projectPath: input.projectPath,
      query,
      input: sdkInput,
      events,
      mapper: new ClaudeMessageMapper(input.projectPath, input.id),
      bridge,
      ...(input.providerConfig ? { providerConfig: { ...input.providerConfig } } : {}),
      capabilities: cloneCapabilities(input.connection.capabilities),
      execution: {
        configured: configuredExecution,
        effective: cloneSessionExecutionSettings(resolvedExecution.effective),
        limitations: resolvedExecution.limitations.map((limitation) => ({ ...limitation })),
      },
      pendingUserInputs: [],
      providerUserMessages: new Map(),
      userMessageUuidsByText: new Map(),
      disposed: false,
      pump: Promise.resolve(),
    }
    sessionReference.current = session
    this.sessions.set(input.id, session)
    session.pump = this.pump(session)

    try {
      await query.initializationResult()
    } catch (error) {
      session.disposed = true
      sdkInput.close()
      query.close()
      await session.pump.catch(() => undefined)
      this.sessions.delete(input.id)
      throw new AdapterError({
        ...toRuntimeError(error, 'connection'),
        layer: 'transport',
      })
    }

    if (session.failure) {
      session.disposed = true
      sdkInput.close()
      query.close()
      await session.pump.catch(() => undefined)
      this.sessions.delete(input.id)
      throw new AdapterError({
        ...toRuntimeError(session.failure, 'connection'),
        layer: 'transport',
      })
    }

    if (input.publishCreated) {
      this.publish(session, {
        type: 'session.created',
        payload: {
          runtimeSessionId: input.runtimeSessionId,
          capabilities: cloneCapabilities(session.capabilities),
        },
      })
    }
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return session
  }

  private async pump(session: ClaudeSessionState): Promise<void> {
    try {
      for await (const message of session.query) {
        if (session.disposed) return
        if (message.type === 'result' && !session.activeTurnId) {
          const messageText =
            message.subtype === 'success'
              ? 'Claude ended before a Gateway turn started'
              : message.errors.join('\n') || message.subtype
          this.publish(session, {
            type: 'runtime.error',
            payload: {
              error: {
                code: 'connection',
                layer: 'transport',
                message: messageText,
                nativeCode: message.subtype,
              },
            },
            nativeRef: { eventId: message.uuid, eventType: `result.${message.subtype}` },
          })
          continue
        }

        // 关联 provider 用户消息 uuid:provider echo 用户消息时按文本对上已发送的输入,
        // 记录 clientMessageId → uuid;同时维护文本 → uuid(resume 重放也能重建),供回退兜底。
        if (message.type === 'user' && message.uuid) {
          const echoedText = claudeUserMessageText(message)
          if (echoedText !== undefined) {
            session.userMessageUuidsByText.set(echoedText.trim(), message.uuid)
            const match = session.pendingUserInputs.findIndex(
              (pending) => pending.text.trim() === echoedText.trim(),
            )
            const pending = match >= 0 ? session.pendingUserInputs.splice(match, 1)[0] : undefined
            if (pending) session.providerUserMessages.set(pending.clientMessageId, message.uuid)
          }
        }

        const mapped = session.mapper.map(message, { turnId: session.activeTurnId ?? session.lastTurnId })
        for (const event of mapped) {
          if (event.type === 'session.created') {
            if (event.payload.runtimeSessionId !== session.runtimeSessionId) {
              throw new Error(
                `Claude initialized session ${event.payload.runtimeSessionId}, expected ${session.runtimeSessionId}`,
              )
            }
            session.capabilities = cloneCapabilities(event.payload.capabilities)
            this.publish(session, {
              type: 'session.capabilities_changed',
              payload: { capabilities: cloneCapabilities(session.capabilities) },
              nativeRef: event.nativeRef,
            })
          } else {
            this.publish(session, event)
          }
        }

        if (message.type === 'result' && session.activeTurnId) {
          const completedTurnId = session.activeTurnId
          session.activeTurnId = undefined
          this.publish(session, {
            type: 'session.status_changed',
            payload: { status: 'idle' },
            turnId: completedTurnId,
          })
          // Claude Code auto-generates a session title after the first turn (small-model
          // summary). The SDK exposes it via getSessionInfo (pull), not an event. Fetch it
          // best-effort so provider auto-titles reach the gateway like Codex/OpenCode.
          if (!session.providerTitle) void this.pullProviderTitle(session)
        }
      }
      if (!session.disposed) throw new Error('Claude Query ended unexpectedly')
    } catch (error) {
      if (session.disposed) return
      session.failure = error
      const runtimeError = { ...toRuntimeError(error, 'connection'), layer: 'transport' as const }
      this.publish(session, { type: 'runtime.error', payload: { error: runtimeError } })
      this.publish(session, {
        type: 'session.status_changed',
        payload: { status: 'error' },
        turnId: session.activeTurnId,
      })
      session.bridge.cancelAll('aborted', runtimeError.message)
      session.input.fail(error)
      session.events.fail(error)
    }
  }

  /**
   * Pull the provider auto-generated title after the first turn. Claude Code writes the
   * `ai-title` to the session JSONL in the background a few seconds AFTER the turn ends
   * (a separate subprocess), so poll across a generous window. Only publish when a real
   * generated title exists (summary differs from the raw first prompt) and we have not
   * already surfaced it.
   */
  private async pullProviderTitle(session: ClaudeSessionState): Promise<void> {
    const ATTEMPTS = 30
    const DELAY_MS = 500
    for (let attempt = 0; attempt < ATTEMPTS && !session.disposed; attempt++) {
      try {
        const info = await claudeGetSessionInfo(session.runtimeSessionId, { dir: session.projectPath })
        if (!session.disposed && info?.summary && info.summary !== info.firstPrompt) {
          session.providerTitle = info.summary
          this.publish(session, {
            type: 'session.title_changed',
            payload: { title: info.summary, source: 'provider' },
          })
          return
        }
      } catch {
        // best-effort; the session keeps its local title when the fetch fails
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  }

  private publish(session: ClaudeSessionState, event: AdapterEvent): void {
    if (session.disposed) return
    session.events.push(event)
    if (event.type === 'interaction.permission_requested' || event.type === 'interaction.question_requested') {
      session.events.push({
        type: 'session.status_changed',
        payload: { status: 'waiting' },
        turnId: event.turnId,
      })
    } else if (
      (event.type === 'interaction.resolved' || event.type === 'interaction.canceled') &&
      session.activeTurnId
    ) {
      session.events.push({
        type: 'session.status_changed',
        payload: { status: 'running' },
        turnId: event.turnId,
      })
    }
  }

  private getConnection(connection: RuntimeConnection): ClaudeConnectionState {
    const state = this.connections.get(connection.id)
    if (!state || state.connection.transport !== 'sdk') {
      throw adapterError('connection', `Unknown Claude SDK connection: ${connection.id}`)
    }
    return state
  }

  private getSession(sessionId: SessionId): ClaudeSessionState {
    const session = this.sessions.get(sessionId)
    if (!session || session.disposed) throw adapterError('connection', `Unknown Claude session: ${sessionId}`)
    return session
  }

}

function mapEffort(value: string | undefined): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!value) return undefined
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value
  }
  throw adapterError('protocol', `Unsupported Claude reasoning effort: ${value}`)
}

function mapModelInfo(model: ModelInfo): ModelCatalog['models'][number] {
  return {
    id: model.value,
    displayName: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    ...(model.value === 'default' ? { isDefault: true } : {}),
    reasoningEfforts: (model.supportedEffortLevels ?? []).map((effort) => ({
      id: effort,
      displayName: effort,
    })),
  }
}

function adapterError(code: 'connection' | 'not_implemented' | 'protocol', message: string): AdapterError {
  return new AdapterError({ code, layer: 'transport', message })
}

function cloneCapabilities(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...capabilities,
    execution: {
      ...capabilities.execution,
      workModes: [...capabilities.execution.workModes],
      approvalActions: [...capabilities.execution.approvalActions],
      approvalReviewers: [...capabilities.execution.approvalReviewers],
      filesystemSandbox: [...capabilities.execution.filesystemSandbox],
      networkAccess: [...capabilities.execution.networkAccess],
    },
    features: { ...capabilities.features },
    raw: [...capabilities.raw],
    ...(capabilities.degradations
      ? { degradations: capabilities.degradations.map((degradation) => ({ ...degradation })) }
      : {}),
  }
}

function executionResult(state: SessionExecutionState): ExecutionConfigurationResult {
  return {
    effective: cloneSessionExecutionSettings(state.effective),
    limitations: state.limitations.map((limitation) => ({ ...limitation })),
  }
}

/** 取 provider 用户消息的纯文本(用于和已发送输入对上关联 uuid)。 */
function claudeUserMessageText(message: SDKUserMessage): string | undefined {
  const content = message.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : 'text' in block ? block.text : ''))
      .join('\n')
  }
  return undefined
}

/** 从 `getSessionMessages` 的原始 message 里取文本块(SessionMessage.message 为 unknown)。 */
function claudeSessionMessageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (typeof message !== 'object' || message === null) return ''
  const record = message as Record<string, unknown>
  const content = record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (typeof block !== 'object' || block === null) return ''
      const entry = block as Record<string, unknown>
      return typeof entry.text === 'string' ? entry.text : ''
    })
    .join('\n')
}

/** Query subprocess env with provider credential/relay overrides merged on top. */
function claudeQueryEnv(
  hostEnv: Record<string, string | undefined> | undefined,
  config?: ProviderRuntimeConfig,
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...hostEnv,
    ...(config?.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
    ...(config?.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}),
  }
}

/** Resolve a user-facing model id through the profile's alias map (identity when unset). */
function resolveClaudeModel(model?: string, config?: ProviderRuntimeConfig): string | undefined {
  if (!model) return undefined
  return config?.modelAliases?.[model] ?? model
}
