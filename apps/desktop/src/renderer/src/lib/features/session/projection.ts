import type { RuntimeFeature, SessionStatus } from '@agent-gateway/core';
import type { RuntimeEventWire } from '@agent-gateway/shared';

export interface ConversationMessage {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	sequence: number;
	turnId?: string;
	streaming: boolean;
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
			return upsertAssistantBlock(base, event, blockId, '', true);
		}
		case 'content.text.delta': {
			const blockId = payloadString(event.payload, 'blockId');
			const delta = payloadString(event.payload, 'delta');
			if (!blockId || delta === undefined) return defer(base, event);
			const id = assistantBlockId(event, blockId);
			const existing = current.messages.find((message) => message.id === id);
			return upsertAssistantBlock(base, event, blockId, `${existing?.text ?? ''}${delta}`, true);
		}
		case 'content.text.completed': {
			const blockId = payloadString(event.payload, 'blockId');
			const text = payloadString(event.payload, 'text');
			if (!blockId || text === undefined) return defer(base, event);
			// Completed is authoritative; it replaces any accumulated live delta.
			return upsertAssistantBlock(base, event, blockId, text, false);
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
	blockId: string,
	text: string,
	streaming: boolean
): ConversationProjection {
	const id = assistantBlockId(event, blockId);
	const index = current.messages.findIndex((message) => message.id === id);
	const message: ConversationMessage = {
		id,
		role: 'assistant',
		text,
		sequence: index >= 0 ? current.messages[index]!.sequence : event.sequence,
		...(event.turnId ? { turnId: event.turnId } : {}),
		streaming
	};
	if (index < 0) return { ...current, messages: [...current.messages, message] };
	return {
		...current,
		messages: current.messages.map((entry, entryIndex) => (entryIndex === index ? message : entry))
	};
}

function assistantBlockId(event: RuntimeEventWire, blockId: string): string {
	return `assistant-${event.turnId ?? 'session'}-${blockId}`;
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
