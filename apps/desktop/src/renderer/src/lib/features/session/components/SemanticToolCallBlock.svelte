<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';
	import { TOOL_STATUS } from '$lib/shared/utils/status';
	import type { ConversationToolCall } from '../projection';
	import ToolActivityText from './ToolActivityText.svelte';
	import {
		formatToolDuration,
		isActiveTool,
		semanticToolLabel,
		toolResultSummary,
		toolResultText,
		toolTarget
	} from './tool-display';

	interface Props {
		item: ConversationToolCall;
	}
	let { item }: Props = $props();
	const active = $derived(isActiveTool(item));
	const visual = $derived(TOOL_STATUS[active ? 'running' : item.toolCall.status]);
	const label = $derived(semanticToolLabel(item.toolCall.kind));
	const target = $derived(toolTarget(item));
	const result = $derived(toolResultText(item));
	const summary = $derived(toolResultSummary(item));
</script>

<details class="group my-1 text-xs">
	<summary
		class="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-default px-1.5 text-muted marker:hidden hover:bg-surface-hover"
	>
		<span
			class="inline-flex h-4 w-4 shrink-0 items-center justify-center text-2xs text-faint transition-transform group-open:rotate-90"
			aria-hidden="true">▶</span
		>
		<span class="shrink-0 text-normal">{label}</span>
		<ToolActivityText text={target} {active} class="min-w-0 truncate" />
		{#if !active && summary}<span class="min-w-0 flex-1 truncate text-faint">— {summary}</span
			>{:else}<span class="flex-1"></span>{/if}
		<span class={cx('shrink-0 text-2xs', visual.text)}>{visual.label}</span>
		{#if item.durationMs !== undefined}<span class="font-mono text-2xs text-faint"
				>{formatToolDuration(item.durationMs)}</span
			>{/if}
	</summary>
	<div class="ml-6 py-1 pr-2">
		{#if result}
			<pre
				class={cx(
					'scroll-thin max-h-72 overflow-auto rounded-default bg-surface-active p-2 text-xs leading-5 whitespace-pre-wrap',
					item.toolCall.error ? 'text-status-error' : 'text-normal'
				)}>{result}</pre>
		{:else}<p class="px-2 py-1 text-faint">
				{active ? `${label}进行中…` : '没有可读文本结果。'}
			</p>{/if}
	</div>
</details>
