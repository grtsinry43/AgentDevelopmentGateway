import type { ToolCall } from '@agent-gateway/core';
import type { ConversationToolCall } from '../projection';

export function isActiveTool(item: ConversationToolCall): boolean {
	return item.toolCall.status === 'pending' || item.toolCall.status === 'running';
}

export function formatToolDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${durationMs}ms`;
	return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function toolTarget(item: ConversationToolCall): string {
	return item.toolCall.presentation?.target?.value ?? item.toolCall.name;
}

export function toolResultText(item: ConversationToolCall): string {
	return (
		item.toolCall.error?.message ?? item.toolCall.presentation?.resultText ?? item.outputDelta ?? ''
	);
}

export function toolResultSummary(item: ConversationToolCall): string {
	return item.toolCall.error?.message ?? item.toolCall.presentation?.resultSummary ?? '';
}

export function semanticToolLabel(kind: ToolCall['kind']): string {
	const labels: Partial<Record<ToolCall['kind'], string>> = {
		'file-read': '读取',
		search: '搜索',
		web: '访问',
		subagent: '子 Agent',
		'task-control': '任务',
		todo: '待办',
		plan: '计划',
		worktree: 'Worktree',
		generic: '调用'
	};
	return labels[kind] ?? '调用';
}

export function truncatedJson(
	value: unknown,
	maxCharacters = 4_000,
	maxLines = 80
): {
	text: string;
	truncated: boolean;
} {
	let serialized: string;
	try {
		serialized = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		serialized = String(value);
	}
	const lines = serialized.split(/\r?\n/);
	const lineLimited = lines.length > maxLines;
	let text = lines.slice(0, maxLines).join('\n');
	const characterLimited = text.length > maxCharacters;
	if (characterLimited) text = text.slice(0, maxCharacters);
	return { text, truncated: lineLimited || characterLimited };
}
