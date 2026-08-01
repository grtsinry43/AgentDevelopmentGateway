import { pushBus } from '$lib/shared/bridge/events';
import type { RuntimeFeature } from '@agent-gateway/core';
import type {
	GatewayAdapterAvailability,
	GatewaySession,
	InteractionResolutionWire,
	RuntimeEventWire
} from '@agent-gateway/shared';
import { interactionRequestSchema, interactionResolutionSchema } from '@agent-gateway/shared';
import {
	createSession,
	getSession,
	listAdapters,
	listSessions,
	resolveSessionInteraction,
	resumeSession,
	sendSessionInput,
	setSessionExecutionSettings,
	setSessionWorkMode,
	unwatchSession,
	watchSession
} from './api';
import {
	emptyConversationProjection,
	projectRuntimeEvent,
	type ConversationMessage,
	type ConversationProjection,
	type ConversationTimelineItem,
	type ConversationToolCall
} from './projection';

export type SessionFilter = 'all' | 'active' | 'waiting' | 'ended';
export type ExecutionPreset = 'standard' | 'read-only' | 'full-access';

const MAX_LOAD_ATTEMPTS = 5;

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
	resolvingInteractionId = $state<string | undefined>(undefined);
	serverError = $state<string | undefined>(undefined);
	error = $state<string | undefined>(undefined);
	streamState = $state<'idle' | 'connecting' | 'connected' | 'retrying' | 'closed' | 'error'>(
		'idle'
	);
	streamMessage = $state<string | undefined>(undefined);
	streamRetryAttempt = $state(0);
	projection = $state.raw<ConversationProjection>(emptyConversationProjection());

	readonly selectedSession = $derived(
		this.sessions.find((session) => session.id === this.selectedSessionId)
	);
	readonly messages = $derived<ConversationMessage[]>(this.projection.messages);
	readonly tools = $derived<ConversationToolCall[]>(this.projection.tools);
	readonly timeline = $derived<ConversationTimelineItem[]>(
		[...this.projection.messages, ...this.projection.tools, ...this.projection.changes].sort(
			(left, right) => left.sequence - right.sequence
		)
	);
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
			if (event.projectKey === this.projectKey) this.#applySessions(event.sessions);
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
		if (sessionId === this.selectedSessionId) return;
		const generation = ++this.#selectionGeneration;
		const previous = this.selectedSessionId;
		this.selectedSessionId = sessionId;
		this.projection = emptyConversationProjection();
		this.#clearReplay();
		this.streamState = 'connecting';
		this.streamMessage = undefined;
		this.streamRetryAttempt = 0;
		this.error = undefined;
		if (previous) await unwatchSession(previous).catch(() => undefined);
		if (generation !== this.#selectionGeneration) return;
		try {
			const session = await getSession(sessionId);
			if (generation !== this.#selectionGeneration) return;
			this.#upsertSession(session);
			this.projection = emptyConversationProjection(session.taskState);
			this.#replaySessionId = sessionId;
			this.#replayTargetSequence = session.lastEventSequence;
			this.#replayProjection = emptyConversationProjection();
			await watchSession(sessionId);
			if (generation !== this.#selectionGeneration) await unwatchSession(sessionId);
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
		this.projection = emptyConversationProjection();
		this.#clearReplay();
		this.streamState = 'idle';
		this.streamMessage = undefined;
		this.streamRetryAttempt = 0;
		this.error = undefined;
		if (previous) await unwatchSession(previous).catch(() => undefined);
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
			await watchSession(sessionId, this.projection.lastSequence);
		} catch (error) {
			this.streamState = 'error';
			this.streamMessage = errorMessage(error);
		}
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
				await watchSession(session.id, this.projection.lastSequence);
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

	setWorkMode(workMode: GatewaySession['execution']['configured']['workMode']): Promise<boolean> {
		return this.#runControl((session) =>
			setSessionWorkMode(session.id, {
				workMode,
				expectedRevision: session.controlRevision
			})
		);
	}

	setExecutionPreset(preset: ExecutionPreset): Promise<boolean> {
		return this.#updateExecution(() => ({
			workMode: 'build',
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
		}));
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

	#updateExecution(
		update: (session: GatewaySession) => GatewaySession['execution']['configured']
	): Promise<boolean> {
		return this.#runControl((session) =>
			setSessionExecutionSettings(session.id, {
				execution: update(session),
				expectedRevision: session.controlRevision
			})
		);
	}
	async #runControl(operation: (session: GatewaySession) => Promise<unknown>): Promise<boolean> {
		const session = this.selectedSession;
		if (!session || this.controlling) return false;
		this.controlling = true;
		this.error = undefined;
		try {
			await operation(session);
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			return false;
		} finally {
			this.controlling = false;
		}
	}

	#applySessions(next: GatewaySession[]): void {
		const byId = new Map(next.map((session) => [session.id, session]));
		this.sessions = [...byId.values()];
		if (this.selectedSessionId && !byId.has(this.selectedSessionId)) {
			const removed = this.selectedSessionId;
			this.#selectionGeneration += 1;
			this.selectedSessionId = undefined;
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
		this.projection = projected;
		this.sessions = this.sessions.map((session) => {
			if (session.id !== event.sessionId) return session;
			const pendingInteractions = projectPendingInteractions(session, event);
			return {
				...session,
				...(projected.status ? { status: projected.status } : {}),
				...(projected.title ? { title: projected.title } : {}),
				...(projected.execution ? { execution: projected.execution } : {}),
				...(projected.controlRevision === undefined
					? {}
					: { controlRevision: projected.controlRevision }),
				pendingInteractions,
				lastEventSequence: Math.max(session.lastEventSequence, event.sequence),
				updatedAt: Math.max(session.updatedAt, event.timestamp)
			};
		});
	}

	#publishReplay(): void {
		if (!this.#replayProjection) return;
		this.projection = this.#replayProjection;
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
