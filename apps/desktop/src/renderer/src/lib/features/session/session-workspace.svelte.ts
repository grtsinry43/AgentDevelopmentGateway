import { pushBus } from '$lib/shared/bridge/events';
import type { RuntimeFeature } from '@agent-gateway/core';
import type {
	GatewayAdapterAvailability,
	GatewaySession,
	RuntimeEventWire
} from '@agent-gateway/shared';
import {
	createSession,
	listAdapters,
	listSessions,
	sendSessionInput,
	unwatchSession,
	watchSession
} from './api';
import {
	emptyConversationProjection,
	projectRuntimeEvent,
	type ConversationMessage,
	type ConversationProjection
} from './projection';

export type SessionFilter = 'all' | 'active' | 'waiting' | 'ended';

class SessionWorkspace {
	projectKey = '';
	sessions = $state.raw<GatewaySession[]>([]);
	adapters = $state.raw<GatewayAdapterAvailability[]>([]);
	selectedSessionId = $state<string | undefined>(undefined);
	search = $state('');
	filter = $state<SessionFilter>('all');
	loading = $state(false);
	sending = $state(false);
	error = $state<string | undefined>(undefined);
	streamState = $state<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle');
	projection = $state.raw<ConversationProjection>(emptyConversationProjection());

	readonly selectedSession = $derived(
		this.sessions.find((session) => session.id === this.selectedSessionId)
	);
	readonly messages = $derived<ConversationMessage[]>(this.projection.messages);
	readonly features = $derived<Partial<Record<RuntimeFeature, boolean>> | undefined>(
		this.projection.features
	);
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
			this.streamState = event.state;
			if (event.state === 'error') this.error = event.message ?? 'Session 事件流中断';
		});

		void this.load();
		return () => {
			this.#started = false;
			this.#loadGeneration += 1;
			this.#selectionGeneration += 1;
			offSessions();
			offEvent();
			offStream();
			const selected = this.selectedSessionId;
			if (selected) void unwatchSession(selected);
		};
	}

	async load(): Promise<void> {
		const generation = ++this.#loadGeneration;
		this.loading = true;
		this.error = undefined;
		try {
			const [sessions, adapters] = await Promise.all([
				listSessions(this.projectKey),
				listAdapters(this.projectKey)
			]);
			if (generation !== this.#loadGeneration) return;
			this.adapters = adapters;
			this.#applySessions(sessions);
			if (!this.selectedSessionId && sessions.length > 0) {
				const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
				if (latest) await this.select(latest.id);
			}
		} catch (error) {
			if (generation === this.#loadGeneration) this.error = errorMessage(error);
		} finally {
			if (generation === this.#loadGeneration) this.loading = false;
		}
	}

	async select(sessionId: string): Promise<void> {
		if (sessionId === this.selectedSessionId) return;
		const generation = ++this.#selectionGeneration;
		const previous = this.selectedSessionId;
		this.selectedSessionId = sessionId;
		this.projection = emptyConversationProjection();
		this.streamState = 'connecting';
		this.error = undefined;
		if (previous) await unwatchSession(previous).catch(() => undefined);
		if (generation !== this.#selectionGeneration) return;
		try {
			await watchSession(sessionId);
			if (generation !== this.#selectionGeneration) await unwatchSession(sessionId);
		} catch (error) {
			if (generation !== this.#selectionGeneration) return;
			this.streamState = 'error';
			this.error = errorMessage(error);
		}
	}

	async beginNewSession(): Promise<void> {
		this.#selectionGeneration += 1;
		const previous = this.selectedSessionId;
		this.selectedSessionId = undefined;
		this.projection = emptyConversationProjection();
		this.streamState = 'idle';
		this.error = undefined;
		if (previous) await unwatchSession(previous).catch(() => undefined);
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
		if (!this.selectedSessionId || this.sending) return false;
		this.sending = true;
		this.error = undefined;
		try {
			await sendSessionInput(this.selectedSessionId, {
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

	#applySessions(next: GatewaySession[]): void {
		const byId = new Map(next.map((session) => [session.id, session]));
		this.sessions = [...byId.values()];
		if (this.selectedSessionId && !byId.has(this.selectedSessionId)) {
			const removed = this.selectedSessionId;
			this.#selectionGeneration += 1;
			this.selectedSessionId = undefined;
			this.projection = emptyConversationProjection();
			this.streamState = 'idle';
			void unwatchSession(removed);
		}
	}

	#acceptEvent(event: RuntimeEventWire): void {
		if (event.sessionId !== this.selectedSessionId) return;
		const projected = projectRuntimeEvent(this.projection, event);
		if (projected === this.projection) return;
		this.projection = projected;
		this.sessions = this.sessions.map((session) => {
			if (session.id !== event.sessionId) return session;
			return {
				...session,
				...(projected.status ? { status: projected.status } : {}),
				...(projected.title ? { title: projected.title } : {}),
				lastEventSequence: Math.max(session.lastEventSequence, event.sequence),
				updatedAt: Math.max(session.updatedAt, event.timestamp)
			};
		});
	}
}

function matchesFilter(session: GatewaySession, filter: SessionFilter): boolean {
	if (filter === 'all') return true;
	if (filter === 'waiting') return session.status === 'waiting';
	if (filter === 'ended') return session.status === 'error' || session.status === 'closed';
	return ['starting', 'idle', 'running', 'interrupted'].includes(session.status);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : '操作失败';
}

export const sessionWorkspace = new SessionWorkspace();
export type SessionWorkspaceState = SessionWorkspace;
