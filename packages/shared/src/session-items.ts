/**
 * Session itemizer —— 服务端增量物化会话对话块(Gateway 领域概念,provider 无关)。
 *
 * 事件溯源里的 read model:把 started/delta/completed 等 durable 事件在到达时增量合并,
 * 块完成即产出一份自包含的成品 `SessionItem`(message / tool / changes / subagent),
 * 供分页查询与导出直接使用,不再需要从全量事件重投影前缀。
 *
 * `applySessionItemEvent` 是**就地可变**的(服务端每事件摊 O(1),避免全量拷贝):
 * 维护 finalized `items` + in-flight `live`(正在流的文本/未结束的工具)。返回本次
 * 定型产出的 items(sequence 即完成事件的 sequence),调用方负责持久化。
 *
 * delta 是 LIVE-ONLY(不落库),completed 事件自带权威全文,因此从 durable 日志
 * 重放也能重建成品 —— 重启对账不需要流式中间态。
 */

import type { ChangeSet, ToolCall } from '@agent-gateway/core'
import type { RuntimeEventWire, SubagentRunWire } from './server-contract.js'

export interface SessionItemMessage {
	itemKind: 'message';
	id: string;
	role: 'user' | 'assistant';
	contentKind: 'text' | 'reasoning';
	text: string;
	sequence: number;
	turnId?: string;
	subagentRunId?: string;
	streaming: boolean;
	startedAt?: number;
	durationMs?: number;
}

export interface SessionItemTool {
	itemKind: 'tool';
	id: string;
	toolCall: ToolCall;
	sequence: number;
	turnId?: string;
	subagentRunId?: string;
	startedAt: number;
	durationMs?: number;
	inputDelta?: string;
	outputDelta?: string;
	changeSet?: ChangeSet;
}

export interface SessionItemChanges {
	itemKind: 'changes';
	id: string;
	changeSet: ChangeSet;
	sequence: number;
	turnId?: string;
	subagentRunId?: string;
}

export interface SessionItemSubagent {
	itemKind: 'subagent';
	id: string;
	run: SubagentRunWire;
	sequence: number;
	turnId?: string;
}

export type SessionItem = SessionItemMessage | SessionItemTool | SessionItemChanges | SessionItemSubagent;

export interface SessionItemState {
	/** 已定型的块(按 sequence 升序)。 */
	items: SessionItem[];
	/** in-flight 块(正在流的文本/推理、未结束的工具/子代理),渲染时拼在 items 尾部。 */
	live: SessionItem[];
	changeSets: Record<string, ChangeSet>;
	toolInputDeltas: Record<string, string>;
	toolOutputDeltas: Record<string, string>;
	lastSequence: number;
}

/** in-flight 文本/推理块(额外的 blockId 用于按 id 匹配,成品不携带)。 */
interface LiveBlock extends SessionItemMessage {
	blockId: string;
}

export function createSessionItemState(): SessionItemState {
	return {
		items: [],
		live: [],
		changeSets: {},
		toolInputDeltas: {},
		toolOutputDeltas: {},
		lastSequence: 0
	};
}

/**
 * 清空已定型缓冲(调用方已持久化)。服务端每事件把 emitted 落库后调用,内存只留
 * in-flight + delta/changeSet 上下文,避免物化器随会话增长膨胀。
 */
export function clearFinalizedItems(state: SessionItemState): void {
	state.items = [];
}

/**
 * 喂一个事件,就地更新 state,返回本次定型产出的 items(sequence = 完成事件 sequence)。
 * 乱序/重复事件直接忽略(sequence <= lastSequence)。
 */
export function applySessionItemEvent(state: SessionItemState, event: RuntimeEventWire): SessionItem[] {
	if (event.sequence <= state.lastSequence) return [];
	state.lastSequence = event.sequence;

	switch (event.type) {
		case 'input.admitted': {
			const text = admittedText(event.payload);
			if (text === undefined) return [];
			const item: SessionItemMessage = {
				itemKind: 'message',
				id: `input-${event.sequence}`,
				role: 'user',
				contentKind: 'text',
				text,
				sequence: event.sequence,
				...(event.turnId ? { turnId: event.turnId } : {}),
				streaming: false
			};
			state.items.push(item);
			return [item];
		}
		case 'content.text.started': {
			const blockId = payloadString(event.payload, 'blockId');
			if (!blockId) return [];
			if (findLiveBlock(state, event, 'text', blockId) >= 0) return [];
			pushLiveBlock(state, event, 'text', blockId, '');
			return [];
		}
		case 'content.text.delta': {
			const blockId = payloadString(event.payload, 'blockId');
			const delta = payloadString(event.payload, 'delta');
			if (!blockId || delta === undefined) return [];
			const index = findLiveBlock(state, event, 'text', blockId);
			if (index < 0) return [];
			(state.live[index] as LiveBlock).text += delta;
			return [];
		}
		case 'content.text.completed': {
			const blockId = payloadString(event.payload, 'blockId');
			const text = payloadString(event.payload, 'text');
			if (!blockId || text === undefined) return [];
			return [finalizeMessage(state, event, 'text', blockId, text)];
		}
		case 'content.reasoning.started': {
			const blockId = payloadString(event.payload, 'blockId');
			if (!blockId) return [];
			if (findLiveBlock(state, event, 'reasoning', blockId) >= 0) return [];
			pushLiveBlock(state, event, 'reasoning', blockId, '');
			return [];
		}
		case 'content.reasoning.delta': {
			const blockId = payloadString(event.payload, 'blockId');
			const delta = payloadString(event.payload, 'delta');
			if (!blockId || delta === undefined) return [];
			const index = findLiveBlock(state, event, 'reasoning', blockId);
			if (index < 0) return [];
			(state.live[index] as LiveBlock).text += delta;
			return [];
		}
		case 'content.reasoning.completed': {
			const blockId = payloadString(event.payload, 'blockId');
			const text = payloadString(event.payload, 'text');
			if (!blockId || text === undefined) return [];
			return [finalizeMessage(state, event, 'reasoning', blockId, text)];
		}
		case 'tool.input_delta': {
			const toolCallId = payloadString(event.payload, 'toolCallId');
			const delta = payloadString(event.payload, 'delta');
			if (!toolCallId || delta === undefined) return [];
			state.toolInputDeltas[toolCallId] = `${state.toolInputDeltas[toolCallId] ?? ''}${delta}`;
			return [];
		}
		case 'tool.output_delta': {
			const toolCallId = payloadString(event.payload, 'toolCallId');
			const delta = payloadString(event.payload, 'delta');
			if (!toolCallId || delta === undefined) return [];
			state.toolOutputDeltas[toolCallId] = `${state.toolOutputDeltas[toolCallId] ?? ''}${delta}`;
			return [];
		}
		case 'tool.started': {
			const toolCall = toolCallPayload(event.payload);
			if (!toolCall) return [];
			const item: SessionItemTool = {
				itemKind: 'tool',
				id: `tool-${toolCall.id}`,
				toolCall,
				sequence: event.sequence,
				...(event.turnId ? { turnId: event.turnId } : {}),
				startedAt: event.timestamp
			};
			upsertLiveTool(state, item, toolCall.id);
			return [];
		}
		case 'tool.completed': {
			const toolCall = toolCallPayload(event.payload);
			if (!toolCall) return [];
			const index = state.live.findIndex(
				(item): item is SessionItemTool =>
					item.itemKind === 'tool' && item.toolCall.id === toolCall.id
			);
			const existing = index >= 0 ? (state.live[index] as SessionItemTool) : undefined;
			const item: SessionItemTool = {
				itemKind: 'tool',
				id: `tool-${toolCall.id}`,
				toolCall,
				sequence: existing?.sequence ?? event.sequence,
				...(event.turnId ? { turnId: event.turnId } : existing?.turnId ? { turnId: existing.turnId } : {}),
				...(existing?.subagentRunId ? { subagentRunId: existing.subagentRunId } : {}),
				startedAt: existing?.startedAt ?? event.timestamp,
				durationMs: Math.max(0, event.timestamp - (existing?.startedAt ?? event.timestamp)),
				...(state.toolInputDeltas[toolCall.id]
					? { inputDelta: state.toolInputDeltas[toolCall.id] }
					: {}),
				...(state.toolOutputDeltas[toolCall.id]
					? { outputDelta: state.toolOutputDeltas[toolCall.id] }
					: {}),
				...(findToolChangeSet(state, toolCall.id)
					? { changeSet: findToolChangeSet(state, toolCall.id) }
					: {})
			};
			if (index >= 0) state.live.splice(index, 1);
			state.items.push(item);
			return [item];
		}
		case 'changes.updated': {
			const changeSet = changeSetPayload(event.payload);
			if (!changeSet) return [];
			state.changeSets[changeSet.id] = changeSet;
			if (changeSet.scope === 'tool' && changeSet.toolCallId) {
				const index = state.live.findIndex(
					(item): item is SessionItemTool =>
						item.itemKind === 'tool' && item.toolCall.id === changeSet.toolCallId
				);
				if (index >= 0) (state.live[index] as SessionItemTool).changeSet = changeSet;
				return [];
			}
			const item: SessionItemChanges = {
				itemKind: 'changes',
				id: `changes-${changeSet.id}`,
				changeSet,
				sequence: event.sequence,
				...(event.turnId ? { turnId: event.turnId } : {})
			};
			state.items.push(item);
			return [item];
		}
		case 'subagent.started':
		case 'subagent.updated': {
			const run = subagentPayload(event.payload);
			if (!run) return [];
			const index = state.live.findIndex(
				(item): item is SessionItemSubagent => item.itemKind === 'subagent' && item.run.id === run.id
			);
			const item: SessionItemSubagent = {
				itemKind: 'subagent',
				id: `subagent-${run.id}`,
				run,
				sequence: event.sequence,
				...(event.turnId ? { turnId: event.turnId } : {})
			};
			if (index >= 0) state.live.splice(index, 1, item);
			else state.live.push(item);
			return [];
		}
		case 'subagent.completed': {
			const run = subagentPayload(event.payload);
			if (!run) return [];
			const index = state.live.findIndex(
				(item): item is SessionItemSubagent => item.itemKind === 'subagent' && item.run.id === run.id
			);
			const existing = index >= 0 ? (state.live[index] as SessionItemSubagent) : undefined;
			const item: SessionItemSubagent = {
				itemKind: 'subagent',
				id: `subagent-${run.id}`,
				run,
				sequence: existing?.sequence ?? event.sequence,
				...(event.turnId ? { turnId: event.turnId } : {})
			};
			if (index >= 0) state.live.splice(index, 1);
			state.items.push(item);
			return [item];
		}
		default:
			return [];
	}
}

/** 产出所有已定型 + in-flight 块(渲染/导出用),按 sequence 升序。 */
export function sessionTimeline(state: SessionItemState): SessionItem[] {
	return [...state.items, ...state.live].sort((a, b) => a.sequence - b.sequence);
}

function pushLiveBlock(
	state: SessionItemState,
	event: RuntimeEventWire,
	contentKind: LiveBlock['contentKind'],
	blockId: string,
	text: string
): void {
	const subagentRunId = eventAttribution(event).subagentRunId;
	const block: LiveBlock = {
		itemKind: 'message',
		role: 'assistant',
		contentKind,
		id: assistantBlockId(event, contentKind, blockId),
		blockId,
		...(event.turnId ? { turnId: event.turnId } : {}),
		...(subagentRunId ? { subagentRunId } : {}),
		text,
		startedAt: event.timestamp,
		sequence: event.sequence,
		streaming: true
	};
	state.live.push(block);
}

function findLiveBlock(
	state: SessionItemState,
	event: RuntimeEventWire,
	contentKind: LiveBlock['contentKind'],
	blockId: string
): number {
	const subagentRunId = eventAttribution(event).subagentRunId;
	const exactId = assistantBlockId(event, contentKind, blockId);
	const exact = state.live.findIndex((item) => item.itemKind === 'message' && item.id === exactId);
	if (exact >= 0) return exact;
	// 同 turn 内同类型仍在流的块视为同一语义块(授权快照只改 id/序号时)。
	for (let index = state.live.length - 1; index >= 0; index -= 1) {
		const item = state.live[index];
		if (
			item?.itemKind === 'message' &&
			item.role === 'assistant' &&
			item.contentKind === contentKind &&
			item.streaming &&
			item.turnId === event.turnId &&
			item.subagentRunId === subagentRunId
		) {
			return index;
		}
	}
	return -1;
}

function finalizeMessage(
	state: SessionItemState,
	event: RuntimeEventWire,
	contentKind: LiveBlock['contentKind'],
	blockId: string,
	text: string
): SessionItemMessage {
	const index = findLiveBlock(state, event, contentKind, blockId);
	const existing = index >= 0 ? (state.live[index] as LiveBlock) : undefined;
	const startedAt = existing?.startedAt ?? event.timestamp;
	const item: SessionItemMessage = {
		itemKind: 'message',
		id: existing?.id ?? assistantBlockId(event, contentKind, blockId),
		role: 'assistant',
		contentKind,
		text,
		sequence: existing?.sequence ?? event.sequence,
		...(event.turnId ? { turnId: event.turnId } : {}),
		...(existing?.subagentRunId ? { subagentRunId: existing.subagentRunId } : {}),
		streaming: false,
		startedAt,
		durationMs: Math.max(0, event.timestamp - startedAt)
	};
	if (index >= 0) state.live.splice(index, 1);
	state.items.push(item);
	return item;
}

function upsertLiveTool(state: SessionItemState, item: SessionItemTool, toolCallId: string): void {
	const index = state.live.findIndex(
		(candidate): candidate is SessionItemTool =>
			candidate.itemKind === 'tool' && candidate.toolCall.id === toolCallId
	);
	if (index >= 0) state.live.splice(index, 1, item);
	else state.live.push(item);
}

function findToolChangeSet(state: SessionItemState, toolCallId: ToolCall['id']): ChangeSet | undefined {
	return Object.values(state.changeSets).find(
		(changeSet) => changeSet.scope === 'tool' && changeSet.toolCallId === toolCallId
	);
}

function assistantBlockId(
	event: RuntimeEventWire,
	contentKind: LiveBlock['contentKind'],
	blockId: string
): string {
	return `assistant-${contentKind}-${event.turnId ?? 'session'}-${blockId}`;
}

function eventAttribution(event: RuntimeEventWire): { subagentRunId?: string } {
	if (!isRecord(event.attribution) || typeof event.attribution.subagentRunId !== 'string') return {};
	return { subagentRunId: event.attribution.subagentRunId };
}

function admittedText(payload: unknown): string | undefined {
	if (!isRecord(payload) || !isRecord(payload.entry) || !isRecord(payload.entry.input)) return undefined;
	return typeof payload.entry.input.text === 'string' ? payload.entry.input.text : undefined;
}

function subagentPayload(payload: unknown): SubagentRunWire | undefined {
	if (!isRecord(payload)) return undefined;
	const value = payload.run;
	if (!isRecord(value) || typeof value.id !== 'string') return undefined;
	return value as unknown as SubagentRunWire;
}

function changeSetPayload(payload: unknown): ChangeSet | undefined {
	if (!isRecord(payload) || !isRecord(payload.changeSet)) return undefined;
	const changeSet = payload.changeSet as unknown as ChangeSet;
	if (typeof changeSet.id !== 'string' || typeof changeSet.scope !== 'string') return undefined;
	return changeSet;
}

function toolCallPayload(payload: unknown): ToolCall | undefined {
	if (!isRecord(payload) || !isRecord(payload.toolCall)) return undefined;
	const value = payload.toolCall as unknown as ToolCall;
	if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.kind !== 'string') {
		return undefined;
	}
	return value;
}

function payloadString(payload: unknown, key: string): string | undefined {
	if (!isRecord(payload)) return undefined;
	return typeof payload[key] === 'string' ? payload[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
