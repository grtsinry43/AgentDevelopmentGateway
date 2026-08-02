import { pushBus } from '$lib/shared/bridge/events';
import { SvelteSet } from 'svelte/reactivity';
import { desktop } from '$lib/shared/bridge/desktop';
import { webPreview } from '$lib/shared/preview/web-preview.svelte';
import {
	applySessionItemEvent,
	createSessionItemState,
	type SessionItem,
	type SessionItemState
} from '@agent-gateway/shared';
import {
	createDefaultSessionExecutionSettings,
	type Host,
	type RuntimeFeature,
	type SessionExecutionSettings
} from '@agent-gateway/core';
import type {
	GatewayAdapterAvailability,
	GatewayModelCatalog,
	GatewaySession,
	InteractionResolutionWire,
	RuntimeControlReceipt,
	RuntimeEventWire
} from '@agent-gateway/shared';
import { interactionRequestSchema, interactionResolutionSchema } from '@agent-gateway/shared';
import {
	closeSession,
	createSession,
	cancelQueuedInput as cancelQueuedInputApi,
	getSession,
	listAdapters,
	listModels,
	listSessionModels,
	listSessions,
	reorderQueuedInputs,
	replaceQueuedInput,
	resolveSessionInteraction,
	resumeSession,
	sendSessionInput,
	sendQueuedInputNow as sendQueuedInputNowApi,
	setSessionExecutionSettings,
	setSessionModel,
	setSessionTitle,
	setSessionWorkMode,
	sessionItems,
	unwatchSession,
	watchSession
} from './api';
import {
	emptyConversationProjection,
	payloadString,
	projectRuntimeEvent,
	type ConversationMessage,
	type ConversationProjection,
	type ConversationTimelineItem,
	type ConversationToolCall
} from './projection';

export type SessionFilter = 'all' | 'active' | 'waiting' | 'ended';
export type ExecutionPreset = 'standard' | 'read-only' | 'full-access';

interface PendingModelSelection {
	sessionId: string;
	model: string;
	reasoningEffort?: string;
	controlRevision?: number;
}

const MAX_LOAD_ATTEMPTS = 5;
/** 标题同步过渡时长(「生成标题…」→ 新标题)。 */
const TITLE_SYNC_MS = 900;
/** 实时尾巴投影的事件类型(其余进 projection 维护会话级状态)。 */
const ITEM_EVENT_TYPES = new Set([
	'input.admitted',
	'content.text.started',
	'content.text.delta',
	'content.text.completed',
	'content.reasoning.started',
	'content.reasoning.delta',
	'content.reasoning.completed',
	'tool.started',
	'tool.completed',
	'tool.input_delta',
	'tool.output_delta',
	'changes.updated',
	'subagent.started',
	'subagent.updated',
	'subagent.completed'
]);

class SessionWorkspace {
	projectKey = '';
	sessions = $state.raw<GatewaySession[]>([]);
	adapters = $state.raw<GatewayAdapterAvailability[]>([]);
	selectedSessionId = $state<string | undefined>(undefined);
	search = $state('');
	filter = $state<SessionFilter>('all');
	loading = $state(false);
	loadFailed = $state(false);
	loadRetryAttempt = $state(0);
	sending = $state(false);
	controlling = $state(false);
	modelCatalog = $state.raw<GatewayModelCatalog | undefined>(undefined);
	modelCatalogLoading = $state(false);
	modelCatalogError = $state<string | undefined>(undefined);
	draftModel = $state<string | undefined>(undefined);
	draftReasoningEffort = $state<string | undefined>(undefined);
	/** 新会话选择的提供商 profile(默认 undefined = 不用 profile)。 */
	draftProviderProfileId = $state<string | undefined>(undefined);
	draftExecution = $state.raw<SessionExecutionSettings>(createDefaultSessionExecutionSettings());
	pendingModelSelection = $state.raw<PendingModelSelection | undefined>(undefined);
	resolvingInteractionId = $state<string | undefined>(undefined);
	queueBusyId = $state<string | undefined>(undefined);
	/** 输入框草稿(跨会话保留;对话右键「引用到输入框」会追加)。 */
	composerDraft = $state('');
	selectedSubagentRunId = $state<string | undefined>(undefined);
	serverError = $state<string | undefined>(undefined);
	error = $state<string | undefined>(undefined);
	streamState = $state<'idle' | 'connecting' | 'connected' | 'retrying' | 'closed' | 'error'>(
		'idle'
	);
	streamMessage = $state<string | undefined>(undefined);
	streamRetryAttempt = $state(0);
	projection = $state.raw<ConversationProjection>(emptyConversationProjection());

	/** 已物化会话块(尾部先取、上滚前插)。 */
	items = $state.raw<SessionItem[]>([]);
	/** 实时尾巴:head 之后事件的共享 itemizer 状态。 */
	liveState: SessionItemState = createSessionItemState();
	/** 每次 live 事件触发一次,驱动 timeline 派生重算(物化 items + live 尾巴)。 */
	liveRevision = $state(0);
	hasMoreOlder = $state(false);
	oldestSequence = $state(0);
	loadingOlder = $state(false);
	/** 已处理的最大事件 seq(实时游标;重连/恢复时从这里接流)。 */
	liveCursor = $state(0);

	/** 标题正在同步中的会话(短暂显示「生成标题…」后切到新标题)。 */
	titleSyncing = new SvelteSet<string>();
	#titleSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly isTitleSyncing = (sessionId: string): boolean => this.titleSyncing.has(sessionId);
	#markTitleSyncing(sessionId: string): void {
		this.titleSyncing.add(sessionId);
		const existing = this.#titleSyncTimers.get(sessionId);
		if (existing) clearTimeout(existing);
		this.#titleSyncTimers.set(
			sessionId,
			setTimeout(() => {
				this.#titleSyncTimers.delete(sessionId);
				this.titleSyncing.delete(sessionId);
			}, TITLE_SYNC_MS)
		);
	}

	readonly selectedSession = $derived(
		this.sessions.find((session) => session.id === this.selectedSessionId)
	);
	readonly messages = $derived<ConversationMessage[]>(this.projection.messages);
	readonly tools = $derived<ConversationToolCall[]>(this.projection.tools);
	readonly subagents = $derived(this.projection.subagents);
	readonly inputQueue = $derived(this.projection.inputQueue);
	readonly selectedSubagent = $derived(
		this.projection.subagents.find((item) => item.run.id === this.selectedSubagentRunId)?.run
	);
	readonly timeline = $derived.by<ConversationTimelineItem[]>(() => {
		// liveRevision 是响应式 token:liveState 就地可变,读它让派生在每次 live 事件后重算。
		void this.liveRevision;
		return [
			...this.items,
			...(this.liveState.items as ConversationTimelineItem[]),
			// 流式块每次重算都换成新对象引用:applySessionItemEvent 就地改 .text,
			// 引用不变的话 keyed each 不会重渲染,文本就卡住不流式了。
			...(this.liveState.live as ConversationTimelineItem[]).map((item) => ({ ...item }))
		]
			.filter((item) => {
				if (item.itemKind === 'subagent') {
					return item.run.parentSubagentRunId === this.selectedSubagentRunId;
				}
				if (item.itemKind === 'tool' && item.toolCall.kind === 'subagent') return false;
				return item.subagentRunId === this.selectedSubagentRunId;
			})
			.sort((left, right) => left.sequence - right.sequence);
	});
	readonly features = $derived<Partial<Record<RuntimeFeature, boolean>> | undefined>(
		this.projection.features
	);
	readonly usage = $derived(this.projection.usage);
	readonly tasks = $derived(this.projection.taskState.tasks);
	readonly taskProgress = $derived.by(() => ({
		completed: this.projection.taskState.tasks.filter((task) => task.status === 'completed').length,
		total: this.projection.taskState.tasks.length
	}));
	readonly availableAdapters = $derived(
		this.adapters.filter(
			(adapter) => adapter.status === 'available' && adapter.installations.length > 0
		)
	);
	readonly serverConnectionStatus = $derived.by<Host['status']>(() => {
		if (!this.projectKey) return 'offline';
		if (this.loading || (this.loadFailed && this.loadRetryAttempt < MAX_LOAD_ATTEMPTS)) {
			return 'connecting';
		}
		if (this.loadFailed) return 'error';
		return 'online';
	});
	readonly filteredSessions = $derived.by(() => {
		const query = this.search.trim().toLocaleLowerCase();
		return [...this.sessions]
			.filter((session) => matchesFilter(session, this.filter))
			.filter((session) => {
				if (!query) return true;
				return [session.title, session.adapterId, session.model]
					.filter((value): value is string => Boolean(value))
					.some((value) => value.toLocaleLowerCase().includes(query));
			})
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});

	#loadGeneration = 0;
	#selectionGeneration = 0;
	#modelCatalogGeneration = 0;
	#pendingControlRevision: number | undefined;
	#started = false;
	#replaySessionId: string | undefined;
	#replayTargetSequence = 0;
	#replayProjection: ConversationProjection | undefined;
	#loadRetryTimer: ReturnType<typeof setTimeout> | undefined;

	start(projectKey: string): () => void {
		if (this.#started) throw new Error('Session workspace 已经启动');
		this.#started = true;
		this.projectKey = projectKey;

		const offSessions = pushBus.on('sessions.changed', (event) => {
			if (event.projectKey === this.projectKey) this.#applySessions(event.sessions, true);
		});
		const offEvent = pushBus.on('session.event', (event) => this.#acceptEvent(event.event));
		const offStream = pushBus.on('session.stream', (event) => {
			if (event.sessionId !== this.selectedSessionId) return;
			const rebuildingHistory =
				this.#replaySessionId === event.sessionId && this.#replayTargetSequence > 0;
			if (!(rebuildingHistory && event.state === 'connected')) this.streamState = event.state;
			if (event.state === 'retrying' || event.state === 'error') {
				this.streamMessage = event.message;
				this.streamRetryAttempt = event.attempt ?? 0;
			} else if (
				event.state === 'connecting' ||
				event.state === 'connected' ||
				event.state === 'closed'
			) {
				this.streamMessage = undefined;
				this.streamRetryAttempt = 0;
			}
			if (
				this.#replaySessionId === event.sessionId &&
				((event.state === 'connected' && this.#replayTargetSequence === 0) ||
					event.state === 'closed')
			) {
				this.#publishReplay();
			}
			if (event.state === 'error') {
				this.#clearReplay();
			}
		});

		void this.load();
		return () => {
			this.#started = false;
			this.#loadGeneration += 1;
			this.#selectionGeneration += 1;
			this.#cancelLoadRetry();
			this.#clearReplay();
			offSessions();
			offEvent();
			offStream();
			const selected = this.selectedSessionId;
			if (selected) void unwatchSession(selected);
		};
	}

	async load(attempt = 1): Promise<void> {
		this.#cancelLoadRetry();
		const generation = ++this.#loadGeneration;
		this.loading = true;
		this.serverError = undefined;
		try {
			const [sessions, adapters] = await Promise.all([
				listSessions(this.projectKey),
				listAdapters(this.projectKey)
			]);
			if (generation !== this.#loadGeneration) return;
			this.adapters = adapters;
			this.loadFailed = false;
			this.loadRetryAttempt = 0;
			this.serverError = undefined;
			this.#applySessions(sessions);
			if (!this.selectedSessionId && sessions.length > 0) {
				const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
				if (latest) await this.select(latest.id);
			} else if (!this.selectedSessionId) {
				const adapter = adapters.find(
					(entry) => entry.status === 'available' && entry.installations.length > 0
				);
				if (adapter) {
					this.resetDraftExecution(adapter.adapterId);
					await this.loadDraftModels(adapter.adapterId, adapter.installations[0]?.path);
				}
			}
		} catch (error) {
			if (generation === this.#loadGeneration) {
				this.loadFailed = true;
				this.loadRetryAttempt = attempt;
				const message = errorMessage(error);
				this.serverError =
					attempt < MAX_LOAD_ATTEMPTS
						? `${message}；正在尝试重新连接（第 ${attempt} 次）`
						: `${message}；自动重连 ${MAX_LOAD_ATTEMPTS} 次仍未恢复`;
				if (attempt < MAX_LOAD_ATTEMPTS) {
					const delay = Math.min(4_000, 500 * 2 ** (attempt - 1));
					this.#loadRetryTimer = setTimeout(() => void this.load(attempt + 1), delay);
				}
			}
		} finally {
			if (generation === this.#loadGeneration) this.loading = false;
		}
	}

	retryServerConnection(): void {
		this.loadFailed = false;
		this.loadRetryAttempt = 0;
		void this.load();
	}

	async select(sessionId: string): Promise<void> {
		if (sessionId === this.selectedSessionId) {
			if (!this.modelCatalog && !this.modelCatalogLoading) {
				await this.#loadSelectedModels(sessionId, this.#selectionGeneration);
			}
			return;
		}
		const generation = ++this.#selectionGeneration;
		const previous = this.selectedSessionId;
		this.selectedSessionId = sessionId;
		this.selectedSubagentRunId = undefined;
		this.projection = emptyConversationProjection();
		this.items = [];
		this.liveState = createSessionItemState();
		this.liveRevision += 1;
		this.hasMoreOlder = false;
		this.oldestSequence = 0;
		// 预览属于具体会话:切换会话时清掉,避免旧会话的页面还挂在右侧面板。
		webPreview.clear();
		this.#clearReplay();
		this.streamState = 'connecting';
		this.streamMessage = undefined;
		this.streamRetryAttempt = 0;
		this.error = undefined;
		this.#resetModelCatalog();
		if (previous) await unwatchSession(previous).catch(() => undefined);
		if (generation !== this.#selectionGeneration) return;
		try {
			const session = await getSession(sessionId);
			if (generation !== this.#selectionGeneration) return;
			this.#upsertSession(session);
			this.projection = emptyConversationProjection(
				session.taskState,
				session.subagentRuns,
				session.inputQueue
			);
			// 渐进加载:只取尾部物化块(历史由 read model 覆盖,不再从 seq 0 全量重放)。
			const tail = await sessionItems(sessionId, undefined, 100);
			if (generation !== this.#selectionGeneration) return;
			this.items = tail.items;
			this.hasMoreOlder = tail.hasMore;
			this.oldestSequence = tail.oldestSequence;
			this.liveCursor = session.lastEventSequence;
			await watchSession(sessionId, session.lastEventSequence);
			if (generation !== this.#selectionGeneration) await unwatchSession(sessionId);
			else await this.#loadSelectedModels(sessionId, generation);
		} catch (error) {
			if (generation !== this.#selectionGeneration) return;
			this.#clearReplay();
			this.streamState = 'error';
			this.error = errorMessage(error);
		}
	}

	async beginNewSession(): Promise<void> {
		this.#selectionGeneration += 1;
		const previous = this.selectedSessionId;
		this.selectedSessionId = undefined;
		this.selectedSubagentRunId = undefined;
		this.projection = emptyConversationProjection();
		this.items = [];
		this.liveState = createSessionItemState();
		this.liveRevision += 1;
		this.hasMoreOlder = false;
		this.oldestSequence = 0;
		this.#clearReplay();
		this.streamState = 'idle';
		this.streamMessage = undefined;
		this.streamRetryAttempt = 0;
		this.error = undefined;
		this.#resetModelCatalog();
		if (previous) await unwatchSession(previous).catch(() => undefined);
		const adapter = this.availableAdapters[0];
		if (adapter) {
			this.resetDraftExecution(adapter.adapterId);
			await this.loadDraftModels(adapter.adapterId, adapter.installations[0]?.path);
		}
	}

	async retryConnection(): Promise<void> {
		const sessionId = this.selectedSessionId;
		if (!sessionId || this.streamState === 'connecting') return;
		this.streamState = 'connecting';
		this.streamMessage = undefined;
		this.streamRetryAttempt = 0;
		try {
			// IPC only acknowledges that Main accepted the watch request. The actual result
			// arrives later through session.stream push events.
			await watchSession(sessionId, this.liveCursor);
		} catch (error) {
			this.streamState = 'error';
			this.streamMessage = errorMessage(error);
		}
	}

	async loadDraftModels(
		adapterId: GatewayAdapterAvailability['adapterId'],
		installationPath?: string
	): Promise<void> {
		const generation = ++this.#modelCatalogGeneration;
		this.modelCatalog = undefined;
		this.modelCatalogLoading = true;
		this.modelCatalogError = undefined;
		this.draftModel = undefined;
		this.draftReasoningEffort = undefined;
		try {
			const catalog = await listModels(this.projectKey, adapterId, {
				...(installationPath ? { installationPath } : {})
			});
			if (generation === this.#modelCatalogGeneration && !this.selectedSessionId) {
				this.modelCatalog = catalog;
				const defaultModel = catalog.models.find((model) => model.isDefault);
				if (!this.draftModel && defaultModel) this.draftModel = defaultModel.id;
			}
		} catch (error) {
			if (generation === this.#modelCatalogGeneration && !this.selectedSessionId) {
				this.modelCatalogError = errorMessage(error);
			}
		} finally {
			if (generation === this.#modelCatalogGeneration) this.modelCatalogLoading = false;
		}
	}

	async reloadSelectedModels(): Promise<void> {
		const sessionId = this.selectedSessionId;
		if (!sessionId || this.modelCatalogLoading) return;
		this.#resetModelCatalog();
		await this.#loadSelectedModels(sessionId, this.#selectionGeneration);
	}

	selectDraftModel(model: string | undefined): void {
		this.draftModel = model;
		this.draftReasoningEffort = undefined;
	}

	selectDraftReasoningEffort(reasoningEffort: string | undefined): void {
		this.draftReasoningEffort = reasoningEffort;
	}

	resetDraftExecution(adapterId: GatewayAdapterAvailability['adapterId']): void {
		const capabilities = this.adapters.find((adapter) => adapter.adapterId === adapterId)
			?.descriptor.capabilities.execution;
		const defaults = createDefaultSessionExecutionSettings();
		if (!capabilities) {
			this.draftExecution = defaults;
			return;
		}
		this.draftExecution = {
			workMode: capabilities.workModes.includes(defaults.workMode)
				? defaults.workMode
				: (capabilities.workModes[0] ?? defaults.workMode),
			approval: {
				defaultAction: capabilities.approvalActions.includes(defaults.approval.defaultAction)
					? defaults.approval.defaultAction
					: (capabilities.approvalActions[0] ?? defaults.approval.defaultAction),
				reviewer: capabilities.approvalReviewers.includes(defaults.approval.reviewer)
					? defaults.approval.reviewer
					: (capabilities.approvalReviewers[0] ?? defaults.approval.reviewer),
				rules: []
			},
			sandbox: {
				filesystem: capabilities.filesystemSandbox.includes(defaults.sandbox.filesystem)
					? defaults.sandbox.filesystem
					: (capabilities.filesystemSandbox[0] ?? defaults.sandbox.filesystem),
				network: capabilities.networkAccess.includes(defaults.sandbox.network)
					? defaults.sandbox.network
					: (capabilities.networkAccess[0] ?? defaults.sandbox.network)
			}
		};
	}

	setDraftWorkMode(workMode: SessionExecutionSettings['workMode']): void {
		this.draftExecution = { ...this.draftExecution, workMode };
	}

	setDraftExecutionPreset(preset: ExecutionPreset): void {
		this.draftExecution = executionPreset(this.draftExecution, preset);
	}

	async createTextSession(
		text: string,
		adapterId: GatewayAdapterAvailability['adapterId'],
		installationPath?: string
	): Promise<boolean> {
		if (this.sending) return false;
		this.sending = true;
		this.error = undefined;
		try {
			const created = await createSession(this.projectKey, {
				adapterId,
				...(installationPath ? { installationPath } : {}),
				...(this.draftProviderProfileId ? { providerProfileId: this.draftProviderProfileId } : {}),
				...(this.draftModel ? { model: this.draftModel } : {}),
				...(this.draftModel && this.draftReasoningEffort
					? { reasoningEffort: this.draftReasoningEffort }
					: {}),
				execution: this.draftExecution,
				initialInput: { clientMessageId: crypto.randomUUID(), text }
			});
			this.#applySessions([...this.sessions, created.session]);
			await this.select(created.session.id);
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			return false;
		} finally {
			this.sending = false;
		}
	}

	async sendText(text: string): Promise<boolean> {
		const selected = this.selectedSession;
		if (!selected || this.sending) return false;
		this.sending = true;
		this.error = undefined;
		try {
			let session = selected;
			if (this.streamState !== 'connected') {
				session = await getSession(selected.id);
				this.#upsertSession(session);
			}
			if (!isLiveSessionStatus(session.status)) {
				const adapter = this.adapters.find((entry) => entry.adapterId === session.adapterId);
				const installationPath =
					adapter?.installations.length === 1 ? adapter.installations[0]?.path : undefined;
				const resumed = await resumeSession(session.id, {
					...(installationPath ? { installationPath } : {})
				});
				this.#upsertSession(resumed);
			}
			if (this.streamState !== 'connected') {
				await watchSession(session.id, this.liveCursor);
			}
			await sendSessionInput(session.id, {
				input: { clientMessageId: crypto.randomUUID(), text }
			});
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			return false;
		} finally {
			this.sending = false;
		}
	}

	/** 把选中的对话片段以 Markdown 引用追加到输入框。 */
	appendComposerQuote(quoted: string): void {
		const block = quoted
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n');
		const base = this.composerDraft.replace(/\s+$/, '');
		this.composerDraft = base ? `${base}\n\n${block}\n\n` : `${block}\n\n`;
	}

	/** 归档(关闭)一个会话;会话保留并标记为已结束。 */
	async archiveSession(sessionId: string): Promise<void> {
		try {
			await closeSession(sessionId, {});
			void this.load();
		} catch (error) {
			this.error = errorMessage(error);
		}
	}

	/** 上滚翻页:取更早的物化块前插。虚拟列表触顶时由界面调用。 */
	async loadOlder(): Promise<void> {
		const sessionId = this.selectedSessionId;
		if (!sessionId || this.loadingOlder || !this.hasMoreOlder) return;
		this.loadingOlder = true;
		try {
			const page = await sessionItems(sessionId, this.oldestSequence, 100);
			this.items = [...page.items, ...this.items];
			this.oldestSequence = page.oldestSequence;
			this.hasMoreOlder = page.hasMore;
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.loadingOlder = false;
		}
	}

	/** 重命名会话标题(下推 provider,并本地刷新列表)。 */
	async renameSession(sessionId: string, title: string): Promise<boolean> {
		const trimmed = title.trim();
		if (!trimmed || this.controlling) return false;
		this.controlling = true;
		this.error = undefined;
		try {
			await setSessionTitle(sessionId, { title: trimmed });
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			return false;
		} finally {
			this.controlling = false;
		}
	}

	openSubagent(runId: string): void {
		if (!this.projection.subagents.some((item) => item.run.id === runId)) return;
		this.selectedSubagentRunId = runId;
	}

	closeSubagent(): void {
		const current = this.selectedSubagent;
		this.selectedSubagentRunId = current?.parentSubagentRunId;
	}

	async editQueuedInput(inputId: string, text: string): Promise<boolean> {
		const session = this.selectedSession;
		const entry = this.inputQueue.find((candidate) => candidate.id === inputId);
		if (!session || !entry || this.queueBusyId) return false;
		this.queueBusyId = inputId;
		this.error = undefined;
		try {
			await replaceQueuedInput(session.id, inputId, {
				input: {
					clientMessageId: inputId,
					text,
					delivery: entry.requestedDelivery
				}
			});
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			return false;
		} finally {
			this.queueBusyId = undefined;
		}
	}

	async moveQueuedInput(inputId: string, offset: -1 | 1): Promise<void> {
		const session = this.selectedSession;
		if (!session || this.queueBusyId) return;
		const ids = this.inputQueue.map((entry) => entry.id);
		const index = ids.indexOf(inputId);
		const target = index + offset;
		if (index < 0 || target < 0 || target >= ids.length) return;
		[ids[index], ids[target]] = [ids[target]!, ids[index]!];
		this.queueBusyId = inputId;
		try {
			await reorderQueuedInputs(session.id, { inputIds: ids });
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.queueBusyId = undefined;
		}
	}

	async cancelQueuedInput(inputId: string): Promise<void> {
		await this.#runQueueOperation(inputId, (sessionId) => cancelQueuedInputApi(sessionId, inputId));
	}

	async sendQueuedInputNow(inputId: string): Promise<void> {
		await this.#runQueueOperation(inputId, (sessionId) =>
			sendQueuedInputNowApi(sessionId, inputId)
		);
	}

	async setWorkMode(
		workMode: GatewaySession['execution']['configured']['workMode']
	): Promise<boolean> {
		const receipt = await this.#runControl((session, expectedRevision) =>
			setSessionWorkMode(session.id, {
				workMode,
				expectedRevision
			})
		);
		return Boolean(receipt);
	}

	async setModel(model: string, reasoningEffort?: string): Promise<boolean> {
		const session = this.selectedSession;
		if (!session || this.controlling) return false;
		const pending: PendingModelSelection = {
			sessionId: session.id,
			model,
			...(reasoningEffort ? { reasoningEffort } : {})
		};
		this.pendingModelSelection = pending;
		const receipt = await this.#runControl((selected, expectedRevision) =>
			setSessionModel(selected.id, {
				model,
				...(reasoningEffort ? { reasoningEffort } : {}),
				expectedRevision
			})
		);
		if (!receipt) {
			if (this.pendingModelSelection === pending) this.pendingModelSelection = undefined;
			return false;
		}
		if (this.pendingModelSelection === pending) {
			this.pendingModelSelection = { ...pending, controlRevision: receipt.controlRevision };
		}
		if (!isLiveSessionStatus(session.status) && session.id === this.selectedSessionId) {
			try {
				this.#upsertSession(await getSession(session.id));
				this.pendingModelSelection = undefined;
				this.#pendingControlRevision = undefined;
			} catch (error) {
				this.error = `模型已保存，但会话状态刷新失败：${errorMessage(error)}`;
			}
		}
		return true;
	}

	setExecutionPreset(preset: ExecutionPreset): Promise<boolean> {
		return this.#updateExecution((session) =>
			executionPreset(session.execution.configured, preset)
		);
	}

	async resolveInteraction(resolution: InteractionResolutionWire): Promise<boolean> {
		const session = this.selectedSession;
		if (!session || this.resolvingInteractionId) return false;
		this.resolvingInteractionId = resolution.id;
		this.error = undefined;
		try {
			// Electron structured clone rejects Svelte state proxies. Interaction resolutions are
			// JSON wire values, so normalize them before crossing the contextBridge boundary.
			const cloneable = interactionResolutionSchema.parse(
				JSON.parse(JSON.stringify(resolution)) as unknown
			);
			await resolveSessionInteraction(session.id, cloneable.id, { resolution: cloneable });
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			return false;
		} finally {
			this.resolvingInteractionId = undefined;
		}
	}

	async #updateExecution(
		update: (session: GatewaySession) => GatewaySession['execution']['configured']
	): Promise<boolean> {
		const receipt = await this.#runControl((session, expectedRevision) =>
			setSessionExecutionSettings(session.id, {
				execution: update(session),
				expectedRevision
			})
		);
		return Boolean(receipt);
	}
	async #runControl(
		operation: (session: GatewaySession, expectedRevision: number) => Promise<RuntimeControlReceipt>
	): Promise<RuntimeControlReceipt | undefined> {
		const session = this.selectedSession;
		if (!session || this.controlling) return undefined;
		this.controlling = true;
		this.error = undefined;
		try {
			const expectedRevision = Math.max(
				session.controlRevision,
				this.#pendingControlRevision ?? session.controlRevision
			);
			const receipt = await operation(session, expectedRevision);
			if (session.id === this.selectedSessionId) {
				this.#pendingControlRevision = Math.max(
					this.#pendingControlRevision ?? 0,
					receipt.controlRevision
				);
			}
			return receipt;
		} catch (error) {
			this.error = errorMessage(error);
			return undefined;
		} finally {
			this.controlling = false;
		}
	}

	async #runQueueOperation(
		inputId: string,
		operation: (sessionId: string) => Promise<void>
	): Promise<void> {
		const session = this.selectedSession;
		if (!session || this.queueBusyId) return;
		this.queueBusyId = inputId;
		this.error = undefined;
		try {
			await operation(session.id);
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.queueBusyId = undefined;
		}
	}

	async #loadSelectedModels(sessionId: string, selectionGeneration: number): Promise<void> {
		const session = this.sessions.find((candidate) => candidate.id === sessionId);
		if (!session) return;
		const generation = ++this.#modelCatalogGeneration;
		this.modelCatalogLoading = true;
		this.modelCatalogError = undefined;
		try {
			const catalog = await listSessionModels(sessionId);
			if (
				generation === this.#modelCatalogGeneration &&
				selectionGeneration === this.#selectionGeneration &&
				sessionId === this.selectedSessionId
			) {
				this.modelCatalog = catalog;
			}
		} catch (error) {
			if (
				generation === this.#modelCatalogGeneration &&
				selectionGeneration === this.#selectionGeneration
			) {
				this.modelCatalogError = errorMessage(error);
			}
		} finally {
			if (generation === this.#modelCatalogGeneration) this.modelCatalogLoading = false;
		}
	}

	#resetModelCatalog(): void {
		this.#modelCatalogGeneration += 1;
		this.modelCatalog = undefined;
		this.modelCatalogLoading = false;
		this.modelCatalogError = undefined;
		this.draftModel = undefined;
		this.draftReasoningEffort = undefined;
		this.pendingModelSelection = undefined;
		this.#pendingControlRevision = undefined;
	}

	#applySessions(next: GatewaySession[], animateTitle = false): void {
		const byId = new Map(next.map((session) => [session.id, session]));
		const previousTitles = new Map(this.sessions.map((session) => [session.id, session.title]));
		this.sessions = [...byId.values()];
		if (animateTitle) {
			for (const session of next) {
				if (session.title && session.title !== previousTitles.get(session.id)) {
					this.#markTitleSyncing(session.id);
				}
			}
		}
		if (this.selectedSessionId && !byId.has(this.selectedSessionId)) {
			const removed = this.selectedSessionId;
			this.#selectionGeneration += 1;
			this.selectedSessionId = undefined;
			this.selectedSubagentRunId = undefined;
			this.projection = emptyConversationProjection();
			this.#clearReplay();
			this.streamState = 'idle';
			this.streamMessage = undefined;
			this.streamRetryAttempt = 0;
			void unwatchSession(removed);
		}
	}

	#acceptEvent(event: RuntimeEventWire): void {
		if (event.sessionId !== this.selectedSessionId) return;
		if (event.sequence > this.liveCursor) this.liveCursor = event.sequence;
		// 扩展事件不投影;在此分发(如 gateway.preview.open → 打开 Web 预览面板)。
		if (event.type === 'runtime.extension') {
			this.#handleExtensionEvent(event);
			return;
		}
		// item 类事件进实时尾巴(共享 itemizer),非 item 事件进 projection 维护会话级状态。
		if (ITEM_EVENT_TYPES.has(event.type)) {
			applySessionItemEvent(this.liveState, event);
			this.liveRevision += 1;
		}
		if (this.#replaySessionId === event.sessionId && this.#replayProjection) {
			this.#replayProjection = projectRuntimeEvent(this.#replayProjection, event);
			if (event.sequence >= this.#replayTargetSequence) {
				this.streamState = 'connected';
				this.#publishReplay();
			}
			return;
		}
		const projected = projectRuntimeEvent(this.projection, event);
		if (projected === this.projection) return;
		if (event.type === 'session.title_changed') {
			const currentTitle = this.sessions.find((session) => session.id === event.sessionId)?.title;
			const nextTitle = payloadString(event.payload, 'title');
			if (nextTitle && nextTitle !== currentTitle) this.#markTitleSyncing(event.sessionId);
		}
		this.projection = projected;
		this.sessions = this.sessions.map((session) => {
			if (session.id !== event.sessionId) return session;
			const pendingInteractions = projectPendingInteractions(session, event);
			return {
				...session,
				...(projected.status ? { status: projected.status } : {}),
				...(projected.title ? { title: projected.title } : {}),
				...(projected.model
					? {
							model: projected.model.model,
							reasoningEffort: projected.model.reasoningEffort
						}
					: {}),
				...(projected.execution ? { execution: projected.execution } : {}),
				...(projected.controlRevision === undefined
					? {}
					: { controlRevision: projected.controlRevision }),
				pendingInteractions,
				subagentRuns: projected.subagents.map((item) => item.run),
				inputQueue: projected.inputQueue,
				lastEventSequence: Math.max(session.lastEventSequence, event.sequence),
				updatedAt: Math.max(session.updatedAt, event.timestamp)
			};
		});
		if (
			(event.type === 'session.model_changed' || event.type === 'session.execution_changed') &&
			projected.controlRevision !== undefined
		) {
			if (
				this.#pendingControlRevision !== undefined &&
				projected.controlRevision >= this.#pendingControlRevision
			) {
				this.#pendingControlRevision = undefined;
			}
			const pending = this.pendingModelSelection;
			if (event.type === 'session.model_changed' && pending?.sessionId === event.sessionId) {
				const matches =
					projected.model?.model === pending.model &&
					projected.model.reasoningEffort === pending.reasoningEffort;
				if (
					matches ||
					(pending.controlRevision !== undefined &&
						projected.controlRevision >= pending.controlRevision)
				) {
					this.pendingModelSelection = undefined;
				}
			}
		}
	}

	/** 分发扩展事件(Feature Registry 之外的小型 hook;未知 feature 忽略)。 */
	#handleExtensionEvent(event: RuntimeEventWire): void {
		const payload = event.payload as { feature?: string; payload?: { port?: number } } | undefined;
		if (payload?.feature === 'gateway.preview.open') {
			const port = payload.payload?.port;
			if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
				void this.#openPreview(port);
			}
		}
	}

	/** 经主进程把 agent 报告的端口解析成客户端可访问地址(远程走 SSH 中转)。 */
	async #openPreview(port: number): Promise<void> {
		try {
			const entry = await desktop.preview.open(port);
			webPreview.open(entry);
		} catch (error) {
			console.error('[preview] 打开预览失败:', error);
		}
	}

	#publishReplay(): void {
		if (!this.#replayProjection) return;
		this.projection = this.#replayProjection;
		if (
			this.selectedSubagentRunId &&
			!this.projection.subagents.some((item) => item.run.id === this.selectedSubagentRunId)
		) {
			this.selectedSubagentRunId = undefined;
		}
		this.#clearReplay();
	}

	#clearReplay(): void {
		this.#replaySessionId = undefined;
		this.#replayTargetSequence = 0;
		this.#replayProjection = undefined;
	}

	#cancelLoadRetry(): void {
		if (this.#loadRetryTimer === undefined) return;
		clearTimeout(this.#loadRetryTimer);
		this.#loadRetryTimer = undefined;
	}

	#upsertSession(next: GatewaySession): void {
		this.sessions = [...this.sessions.filter((session) => session.id !== next.id), next];
	}
}

function projectPendingInteractions(
	session: GatewaySession,
	event: RuntimeEventWire
): GatewaySession['pendingInteractions'] {
	if (
		event.type === 'interaction.permission_requested' ||
		event.type === 'interaction.question_requested' ||
		event.type === 'interaction.grant_requested' ||
		event.type === 'interaction.dialog_requested' ||
		event.type === 'interaction.elicitation_requested'
	) {
		if (!isRecord(event.payload)) return session.pendingInteractions;
		const parsed = interactionRequestSchema.safeParse(event.payload.request);
		if (!parsed.success) return session.pendingInteractions;
		return [
			...session.pendingInteractions.filter((request) => request.id !== parsed.data.id),
			parsed.data
		].sort((left, right) => left.createdAt - right.createdAt);
	}
	if (event.type === 'interaction.resolved' || event.type === 'interaction.canceled') {
		if (!isRecord(event.payload) || typeof event.payload.id !== 'string') {
			return session.pendingInteractions;
		}
		const resolvedId = event.payload.id;
		return session.pendingInteractions.filter((request) => request.id !== resolvedId);
	}
	return session.pendingInteractions;
}

function executionPreset(
	current: SessionExecutionSettings,
	preset: ExecutionPreset
): SessionExecutionSettings {
	return {
		...current,
		approval: {
			defaultAction: preset === 'full-access' ? 'allow' : 'ask',
			reviewer: 'user',
			rules: []
		},
		sandbox: {
			filesystem:
				preset === 'full-access'
					? 'unrestricted'
					: preset === 'read-only'
						? 'read-only'
						: 'workspace-write',
			network: preset === 'full-access' ? 'allow' : 'ask'
		}
	};
}

function matchesFilter(session: GatewaySession, filter: SessionFilter): boolean {
	if (filter === 'all') return true;
	if (filter === 'waiting') return session.status === 'waiting';
	if (filter === 'ended') return session.status === 'error' || session.status === 'closed';
	return ['starting', 'idle', 'running', 'interrupted'].includes(session.status);
}

function isLiveSessionStatus(status: GatewaySession['status']): boolean {
	return status === 'starting' || status === 'idle' || status === 'running' || status === 'waiting';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : '操作失败';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const sessionWorkspace = new SessionWorkspace();
export type SessionWorkspaceState = SessionWorkspace;
