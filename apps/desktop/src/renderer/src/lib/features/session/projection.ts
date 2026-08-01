import type { RuntimeFeature, SessionStatus } from '@agent-gateway/core';
import type { RuntimeEventWire } from '@agent-gateway/shared';

export interface ConversationMessage {
	id: string;
	role: 'user' | 'assistant';
	contentKind: 'text' | 'reasoning';
	text: string;
	sequence: number;
	turnId?: string;
	streaming: boolean;
	startedAt?: number;
	durationMs?: number;
}

export interface ConversationProjection {
	messages: ConversationMessage[];
	lastSequence: number;
	status?: SessionStatus;
	title?: string;
	features?: Partial<Record<RuntimeFeature, boolean>>;
	/** Known-but-not-rendered and unknown events remain available for future feature renderers. */
	deferredEvents: RuntimeEventWire[];
}

export function emptyConversationProjection(): ConversationProjection {
	return { messages: [], lastSequence: 0, deferredEvents: [] };
}

export function projectRuntimeEvent(
	current: ConversationProjection,
	event: RuntimeEventWire
): ConversationProjection {
	if (event.sequence <= current.lastSequence) return current;

	const base = { ...current, lastSequence: event.sequence };
	switch (event.type) {
		case 'input.admitted': {
			const text = admittedText(event.payload);
			if (text === undefined) return defer(base, event);
			return {
				...base,
				messages: [
					...current.messages,
					{
						id: `input-${event.sequence}`,
						role: 'user',
						contentKind: 'text',
						text,
						sequence: event.sequence,
						...(event.turnId ? { turnId: event.turnId } : {}),
						streaming: false
					}
				]
			};
		}
		case 'content.text.started': {
			const blockId = payloadString(event.payload, 'blockId');
			if (!blockId) return defer(base, event);
			// Some Claude SDK snapshots renumber a streamed text block (for example :1 → :0).
			// Do not create a second row while the same turn already has one active text block.
			if (findAssistantBlockIndex(base, event, 'text', blockId, true) >= 0) return base;
			return upsertAssistantBlock(base, event, 'text', blockId, '', true);
		}
		case 'content.text.delta': {
			const blockId = payloadString(event.payload, 'blockId');
			const delta = payloadString(event.payload, 'delta');
			if (!blockId || delta === undefined) return defer(base, event);
			const index = findAssistantBlockIndex(current, event, 'text', blockId, true);
			const existing = index >= 0 ? current.messages[index] : undefined;
			return upsertAssistantBlock(
				base,
				event,
				'text',
				blockId,
				`${existing?.text ?? ''}${delta}`,
				true,
				true
			);
		}
		case 'content.text.completed': {
			const blockId = payloadString(event.payload, 'blockId');
			const text = payloadString(event.payload, 'text');
			if (!blockId || text === undefined) return defer(base, event);
			// Completed is authoritative; it replaces any accumulated live delta.
			return upsertAssistantBlock(base, event, 'text', blockId, text, false, true);
		}
		case 'content.reasoning.started': {
			const blockId = payloadString(event.payload, 'blockId');
			if (!blockId) return defer(base, event);
			if (findAssistantBlockIndex(base, event, 'reasoning', blockId, true) >= 0) return base;
			return upsertAssistantBlock(base, event, 'reasoning', blockId, '', true, false, {
				startedAt: event.timestamp
			});
		}
		case 'content.reasoning.delta': {
			const blockId = payloadString(event.payload, 'blockId');
			const delta = payloadString(event.payload, 'delta');
			if (!blockId || delta === undefined) return defer(base, event);
			const index = findAssistantBlockIndex(current, event, 'reasoning', blockId, true);
			const existing = index >= 0 ? current.messages[index] : undefined;
			return upsertAssistantBlock(
				base,
				event,
				'reasoning',
				blockId,
				`${existing?.text ?? ''}${delta}`,
				true,
				true
			);
		}
		case 'content.reasoning.completed': {
			const blockId = payloadString(event.payload, 'blockId');
			const text = payloadString(event.payload, 'text');
			if (!blockId || text === undefined) return defer(base, event);
			const index = findAssistantBlockIndex(current, event, 'reasoning', blockId, true);
			const startedAt = index >= 0 ? current.messages[index]?.startedAt : undefined;
			return upsertAssistantBlock(
				base,
				event,
				'reasoning',
				blockId,
				text,
				false,
				true,
				startedAt === undefined ? {} : { durationMs: Math.max(0, event.timestamp - startedAt) }
			);
		}
		case 'session.status_changed': {
			const status = sessionStatus(event.payload);
			return status ? { ...base, status } : defer(base, event);
		}
		case 'session.title_changed': {
			const title = payloadString(event.payload, 'title');
			return title === undefined ? defer(base, event) : { ...base, title };
		}
		case 'session.created':
		case 'session.capabilities_changed': {
			const features = capabilityFeatures(event.payload);
			return features ? { ...base, features } : defer(base, event);
		}
		default:
			return defer(base, event);
	}
}

function upsertAssistantBlock(
	current: ConversationProjection,
	event: RuntimeEventWire,
	contentKind: ConversationMessage['contentKind'],
	blockId: string,
	text: string,
	streaming: boolean,
	reconcileActiveTurn = false,
	metadata: Pick<ConversationMessage, 'startedAt' | 'durationMs'> = {}
): ConversationProjection {
	const id = assistantBlockId(event, contentKind, blockId);
	const index = findAssistantBlockIndex(current, event, contentKind, blockId, reconcileActiveTurn);
	const existing = index >= 0 ? current.messages[index] : undefined;
	const message: ConversationMessage = {
		// Preserve the live block's UI identity when an authoritative snapshot renumbers it.
		id: existing?.id ?? id,
		role: 'assistant',
		contentKind,
		text,
		sequence: existing?.sequence ?? event.sequence,
		...(event.turnId ? { turnId: event.turnId } : {}),
		streaming,
		...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
		...(existing?.durationMs === undefined ? {} : { durationMs: existing.durationMs }),
		...metadata
	};
	if (index < 0) return { ...current, messages: [...current.messages, message] };
	return {
		...current,
		messages: current.messages.map((entry, entryIndex) => (entryIndex === index ? message : entry))
	};
}

function findAssistantBlockIndex(
	current: ConversationProjection,
	event: RuntimeEventWire,
	contentKind: ConversationMessage['contentKind'],
	blockId: string,
	reconcileActiveTurn: boolean
): number {
	const exactId = assistantBlockId(event, contentKind, blockId);
	const exact = current.messages.findIndex((message) => message.id === exactId);
	if (exact >= 0 || !reconcileActiveTurn) return exact;

	// Blocks of the same kind are sequential within a turn. A still-streaming block is the
	// same semantic block when a later authoritative SDK snapshot changes only its id/index.
	for (let index = current.messages.length - 1; index >= 0; index -= 1) {
		const message = current.messages[index];
		if (
			message?.role === 'assistant' &&
			message.contentKind === contentKind &&
			message.streaming &&
			message.turnId === event.turnId
		) {
			return index;
		}
	}
	return -1;
}

function assistantBlockId(
	event: RuntimeEventWire,
	contentKind: ConversationMessage['contentKind'],
	blockId: string
): string {
	return `assistant-${contentKind}-${event.turnId ?? 'session'}-${blockId}`;
}

function defer(current: ConversationProjection, event: RuntimeEventWire): ConversationProjection {
	return { ...current, deferredEvents: [...current.deferredEvents, event] };
}

function admittedText(payload: unknown): string | undefined {
	if (!isRecord(payload) || !isRecord(payload.input)) return undefined;
	return typeof payload.input.text === 'string' ? payload.input.text : undefined;
}

function payloadString(payload: unknown, key: string): string | undefined {
	if (!isRecord(payload)) return undefined;
	return typeof payload[key] === 'string' ? payload[key] : undefined;
}

function sessionStatus(payload: unknown): SessionStatus | undefined {
	const value = payloadString(payload, 'status');
	return value && SESSION_STATUSES.has(value as SessionStatus)
		? (value as SessionStatus)
		: undefined;
}

function capabilityFeatures(
	payload: unknown
): Partial<Record<RuntimeFeature, boolean>> | undefined {
	if (!isRecord(payload) || !isRecord(payload.capabilities)) return undefined;
	const value = payload.capabilities.features;
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
	);
	return Object.fromEntries(entries) as Partial<Record<RuntimeFeature, boolean>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SESSION_STATUSES = new Set<SessionStatus>([
	'starting',
	'idle',
	'running',
	'waiting',
	'interrupted',
	'error',
	'closed'
]);
