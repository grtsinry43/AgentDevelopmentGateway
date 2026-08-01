import type {
	ChangeSet,
	RuntimeFeature,
	SessionExecutionState,
	SessionStatus,
	TaskState,
	ToolCall,
	Usage
} from '@agent-gateway/core';
import { applyTaskStateUpdate, cloneTaskState, createEmptyTaskState } from '@agent-gateway/core';
import {
	changesUpdatedPayloadSchema,
	inputQueueEntrySchema,
	sessionExecutionStateSchema,
	subagentRunSchema,
	toolPresentationSchema,
	taskUpdatedPayloadSchema,
	type InputQueueEntryWire,
	type RuntimeEventWire,
	type SubagentRunWire
} from '@agent-gateway/shared';

export interface ConversationMessage {
	itemKind: 'message';
	id: string;
	role: 'user' | 'assistant';
	contentKind: 'text' | 'reasoning';
	text: string;
	sequence: number;
	turnId?: string;
	streaming: boolean;
	startedAt?: number;
	durationMs?: number;
	subagentRunId?: string;
}

export interface ConversationToolCall {
	itemKind: 'tool';
	id: string;
	toolCall: ToolCall;
	sequence: number;
	turnId?: string;
	startedAt: number;
	durationMs?: number;
	inputDelta?: string;
	outputDelta?: string;
	changeSet?: ChangeSet;
	subagentRunId?: string;
}

export interface ConversationChangeSet {
	itemKind: 'changes';
	id: string;
	changeSet: ChangeSet;
	sequence: number;
	turnId?: string;
	subagentRunId?: string;
}

export interface ConversationSubagentRun {
	itemKind: 'subagent';
	id: string;
	run: SubagentRunWire;
	sequence: number;
	turnId?: string;
}

export type ConversationTimelineItem =
	ConversationMessage | ConversationToolCall | ConversationChangeSet | ConversationSubagentRun;

export interface ConversationProjection {
	messages: ConversationMessage[];
	tools: ConversationToolCall[];
	changes: ConversationChangeSet[];
	subagents: ConversationSubagentRun[];
	inputQueue: InputQueueEntryWire[];
	changeSets: Record<string, ChangeSet>;
	toolInputDeltas: Record<string, string>;
	toolOutputDeltas: Record<string, string>;
	lastSequence: number;
	status?: SessionStatus;
	title?: string;
	features?: Partial<Record<RuntimeFeature, boolean>>;
	usage?: Usage;
	execution?: SessionExecutionState;
	controlRevision?: number;
	taskState: TaskState;
	/** Known-but-not-rendered and unknown events remain available for future feature renderers. */
	deferredEvents: RuntimeEventWire[];
}

export function emptyConversationProjection(
	taskState: TaskState = createEmptyTaskState(),
	subagentRuns: SubagentRunWire[] = [],
	inputQueue: InputQueueEntryWire[] = []
): ConversationProjection {
	return {
		messages: [],
		tools: [],
		changes: [],
		subagents: subagentRuns.map((run, index) => ({
			itemKind: 'subagent',
			id: `subagent-${run.id}`,
			run,
			sequence: Number.MAX_SAFE_INTEGER - subagentRuns.length + index
		})),
		inputQueue: [...inputQueue],
		changeSets: {},
		toolInputDeltas: {},
		toolOutputDeltas: {},
		lastSequence: 0,
		taskState: cloneTaskState(taskState),
		deferredEvents: []
	};
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
						itemKind: 'message',
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
		case 'input.queue_updated': {
			const entries = inputQueuePayload(event.payload);
			return entries ? { ...base, inputQueue: entries } : defer(base, event);
		}
		case 'subagent.started':
		case 'subagent.updated':
		case 'subagent.completed': {
			const run = subagentPayload(event.payload);
			return run ? upsertSubagent(base, event, run) : defer(base, event);
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
		case 'usage.updated': {
			const usage = usagePayload(event.payload);
			return usage ? { ...base, usage } : defer(base, event);
		}
		case 'session.execution_changed': {
			const execution = executionPayload(event.payload);
			const controlRevision = payloadNumber(event.payload, 'controlRevision');
			return execution && controlRevision !== undefined
				? { ...base, execution, controlRevision }
				: defer(base, event);
		}
		case 'tool.input_delta': {
			const toolCallId = payloadString(event.payload, 'toolCallId');
			const delta = payloadString(event.payload, 'delta');
			if (!toolCallId || delta === undefined) return defer(base, event);
			return appendToolDelta(base, toolCallId, delta, 'input');
		}
		case 'tool.output_delta': {
			const toolCallId = payloadString(event.payload, 'toolCallId');
			const delta = payloadString(event.payload, 'delta');
			if (!toolCallId || delta === undefined) return defer(base, event);
			return appendToolDelta(base, toolCallId, delta, 'output');
		}
		case 'tool.started': {
			const toolCall = toolCallPayload(event.payload);
			if (!toolCall) return defer(base, event);
			return upsertToolCall(base, event, toolCall, false);
		}
		case 'tool.completed': {
			const toolCall = toolCallPayload(event.payload);
			if (!toolCall) return defer(base, event);
			return upsertToolCall(base, event, toolCall, true);
		}
		case 'changes.updated': {
			const changeSet = changeSetPayload(event.payload);
			if (!changeSet) return defer(base, event);
			return upsertChangeSet(base, event, changeSet);
		}
		case 'task.updated': {
			const parsed = taskUpdatedPayloadSchema.safeParse(event.payload);
			return parsed.success
				? { ...base, taskState: applyTaskStateUpdate(current.taskState, parsed.data.update) }
				: defer(base, event);
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
		itemKind: 'message',
		// Preserve the live block's UI identity when an authoritative snapshot renumbers it.
		id: existing?.id ?? id,
		role: 'assistant',
		contentKind,
		text,
		sequence: existing?.sequence ?? event.sequence,
		...(event.turnId ? { turnId: event.turnId } : {}),
		...eventAttribution(event),
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

function appendToolDelta(
	current: ConversationProjection,
	toolCallId: string,
	delta: string,
	channel: 'input' | 'output'
): ConversationProjection {
	const deltas = channel === 'input' ? current.toolInputDeltas : current.toolOutputDeltas;
	const nextValue = `${deltas[toolCallId] ?? ''}${delta}`;
	const nextDeltas = { ...deltas, [toolCallId]: nextValue };
	return {
		...current,
		...(channel === 'input' ? { toolInputDeltas: nextDeltas } : { toolOutputDeltas: nextDeltas }),
		tools: current.tools.map((item) =>
			item.toolCall.id === toolCallId
				? {
						...item,
						...(channel === 'input' ? { inputDelta: nextValue } : { outputDelta: nextValue })
					}
				: item
		)
	};
}

function upsertToolCall(
	current: ConversationProjection,
	event: RuntimeEventWire,
	toolCall: ToolCall,
	completed: boolean
): ConversationProjection {
	const index = current.tools.findIndex((item) => item.toolCall.id === toolCall.id);
	const existing = index >= 0 ? current.tools[index] : undefined;
	const item: ConversationToolCall = {
		itemKind: 'tool',
		id: `tool-${toolCall.id}`,
		toolCall,
		sequence: existing?.sequence ?? event.sequence,
		...(event.turnId
			? { turnId: event.turnId }
			: existing?.turnId
				? { turnId: existing.turnId }
				: {}),
		...eventAttribution(event),
		startedAt: existing?.startedAt ?? event.timestamp,
		...(completed
			? { durationMs: Math.max(0, event.timestamp - (existing?.startedAt ?? event.timestamp)) }
			: {}),
		...(current.toolInputDeltas[toolCall.id]
			? { inputDelta: current.toolInputDeltas[toolCall.id] }
			: {}),
		...(current.toolOutputDeltas[toolCall.id]
			? { outputDelta: current.toolOutputDeltas[toolCall.id] }
			: {}),
		...(findToolChangeSet(current, toolCall.id)
			? { changeSet: findToolChangeSet(current, toolCall.id) }
			: {})
	};
	if (index < 0) return { ...current, tools: [...current.tools, item] };
	return {
		...current,
		tools: current.tools.map((entry, entryIndex) => (entryIndex === index ? item : entry))
	};
}

function upsertChangeSet(
	current: ConversationProjection,
	event: RuntimeEventWire,
	changeSet: ChangeSet
): ConversationProjection {
	const changeSets = { ...current.changeSets, [changeSet.id]: changeSet };
	const tools = changeSet.toolCallId
		? current.tools.map((item) =>
				item.toolCall.id === changeSet.toolCallId ? { ...item, changeSet } : item
			)
		: current.tools;
	if (changeSet.scope === 'tool' && changeSet.toolCallId) {
		return { ...current, changeSets, tools };
	}

	const index = current.changes.findIndex((item) => item.changeSet.id === changeSet.id);
	const item: ConversationChangeSet = {
		itemKind: 'changes',
		id: `changes-${changeSet.id}`,
		changeSet,
		sequence: index >= 0 ? (current.changes[index]?.sequence ?? event.sequence) : event.sequence,
		...(event.turnId ? { turnId: event.turnId } : {}),
		...eventAttribution(event)
	};
	return {
		...current,
		changeSets,
		tools,
		changes:
			index < 0
				? [...current.changes, item]
				: current.changes.map((entry, entryIndex) => (entryIndex === index ? item : entry))
	};
}

function upsertSubagent(
	current: ConversationProjection,
	event: RuntimeEventWire,
	run: SubagentRunWire
): ConversationProjection {
	const index = current.subagents.findIndex((item) => item.run.id === run.id);
	const existing = index >= 0 ? current.subagents[index] : undefined;
	const item: ConversationSubagentRun = {
		itemKind: 'subagent',
		id: `subagent-${run.id}`,
		run,
		sequence: existing?.sequence ?? event.sequence,
		...(event.turnId ? { turnId: event.turnId } : {})
	};
	return {
		...current,
		subagents:
			index < 0
				? [...current.subagents, item]
				: current.subagents.map((entry, entryIndex) => (entryIndex === index ? item : entry))
	};
}

function findToolChangeSet(
	current: ConversationProjection,
	toolCallId: ToolCall['id']
): ChangeSet | undefined {
	return Object.values(current.changeSets).find(
		(changeSet) => changeSet.scope === 'tool' && changeSet.toolCallId === toolCallId
	);
}

function findAssistantBlockIndex(
	current: ConversationProjection,
	event: RuntimeEventWire,
	contentKind: ConversationMessage['contentKind'],
	blockId: string,
	reconcileActiveTurn: boolean
): number {
	const subagentRunId = eventAttribution(event).subagentRunId;
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
			message.turnId === event.turnId &&
			message.subagentRunId === subagentRunId
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
	if (!isRecord(payload) || !isRecord(payload.entry) || !isRecord(payload.entry.input)) {
		return undefined;
	}
	return typeof payload.entry.input.text === 'string' ? payload.entry.input.text : undefined;
}

function inputQueuePayload(payload: unknown): InputQueueEntryWire[] | undefined {
	if (!isRecord(payload)) return undefined;
	const parsed = inputQueueEntrySchema.array().safeParse(payload.entries);
	return parsed.success ? parsed.data : undefined;
}

function subagentPayload(payload: unknown): SubagentRunWire | undefined {
	if (!isRecord(payload)) return undefined;
	const parsed = subagentRunSchema.safeParse(payload.run);
	return parsed.success ? parsed.data : undefined;
}

function eventAttribution(event: RuntimeEventWire): { subagentRunId?: string } {
	if (!isRecord(event.attribution) || typeof event.attribution.subagentRunId !== 'string')
		return {};
	return { subagentRunId: event.attribution.subagentRunId };
}

function payloadString(payload: unknown, key: string): string | undefined {
	if (!isRecord(payload)) return undefined;
	return typeof payload[key] === 'string' ? payload[key] : undefined;
}

function payloadNumber(payload: unknown, key: string): number | undefined {
	if (!isRecord(payload)) return undefined;
	const value = payload[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function usagePayload(payload: unknown): Usage | undefined {
	if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
	const usage = payload.usage;
	const numericEntries = [
		'inputTokens',
		'outputTokens',
		'cachedInputTokens',
		'cacheCreationInputTokens',
		'reasoningTokens',
		'totalTokens',
		'costUsd',
		'webSearchRequests',
		'contextWindow'
	] as const satisfies readonly (keyof Usage)[];
	const normalized: Usage = {};
	for (const key of numericEntries) {
		const value = usage[key];
		if (typeof value === 'number' && Number.isFinite(value)) normalized[key] = value;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function executionPayload(payload: unknown): SessionExecutionState | undefined {
	if (!isRecord(payload)) return undefined;
	const parsed = sessionExecutionStateSchema.safeParse(payload.execution);
	return parsed.success ? parsed.data : undefined;
}

function changeSetPayload(payload: unknown): ChangeSet | undefined {
	const parsed = changesUpdatedPayloadSchema.safeParse(payload);
	return parsed.success ? (parsed.data.changeSet as ChangeSet) : undefined;
}

function toolCallPayload(payload: unknown): ToolCall | undefined {
	if (!isRecord(payload) || !isRecord(payload.toolCall)) return undefined;
	const value = payload.toolCall;
	if (
		typeof value.id !== 'string' ||
		typeof value.name !== 'string' ||
		typeof value.kind !== 'string' ||
		typeof value.status !== 'string' ||
		!TOOL_KINDS.has(value.kind as ToolCall['kind']) ||
		!TOOL_STATUSES.has(value.status as ToolCall['status'])
	) {
		return undefined;
	}
	const error = toolError(value.error);
	const presentation = toolPresentation(value.presentation);
	return {
		id: value.id as ToolCall['id'],
		name: value.name,
		kind: value.kind as ToolCall['kind'],
		status: value.status as ToolCall['status'],
		...('input' in value ? { input: value.input } : {}),
		...(presentation ? { presentation } : {}),
		...('result' in value ? { result: value.result } : {}),
		...('structured' in value ? { structured: value.structured } : {}),
		...(Array.isArray(value.outputPaths) &&
		value.outputPaths.every((path) => typeof path === 'string')
			? { outputPaths: value.outputPaths }
			: {}),
		...(typeof value.providerExecuted === 'boolean'
			? { providerExecuted: value.providerExecuted }
			: {}),
		...(typeof value.prunedAt === 'number' ? { prunedAt: value.prunedAt } : {}),
		...(error ? { error } : {})
	};
}

function toolPresentation(value: unknown): ToolCall['presentation'] | undefined {
	const parsed = toolPresentationSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function toolError(value: unknown): ToolCall['error'] | undefined {
	if (
		!isRecord(value) ||
		typeof value.code !== 'string' ||
		!RUNTIME_ERROR_CODES.has(value.code as NonNullable<ToolCall['error']>['code']) ||
		typeof value.message !== 'string'
	) {
		return undefined;
	}
	return {
		code: value.code as NonNullable<ToolCall['error']>['code'],
		message: value.message
	};
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

const TOOL_KINDS = new Set<ToolCall['kind']>([
	'terminal',
	'file-read',
	'file-edit',
	'file-diff',
	'notebook-edit',
	'search',
	'web',
	'subagent',
	'task-control',
	'todo',
	'plan',
	'mcp',
	'worktree',
	'generic'
]);

const TOOL_STATUSES = new Set<ToolCall['status']>([
	'pending',
	'running',
	'completed',
	'declined',
	'error'
]);

const RUNTIME_ERROR_CODES = new Set<NonNullable<ToolCall['error']>['code']>([
	'connection',
	'protocol',
	'auth',
	'rate_limit',
	'budget_exhausted',
	'max_turns',
	'context_overflow',
	'model_refusal',
	'not_implemented',
	'interrupted',
	'declined',
	'unknown'
]);
