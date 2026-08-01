<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';
	import { TOOL_STATUS } from '$lib/shared/utils/status';
	import type { ConversationToolCall } from '../projection';
	import ToolActivityText from './ToolActivityText.svelte';
	import ToolCallLeadingIcons from './ToolCallLeadingIcons.svelte';
	import { formatToolDuration, isActiveTool, toolTarget, truncatedJson } from './tool-display';

	interface Props {
		item: ConversationToolCall;
	}
	let { item }: Props = $props();
	const active = $derived(isActiveTool(item));
	const visual = $derived(TOOL_STATUS[active ? 'running' : item.toolCall.status]);
	const request = $derived(truncatedJson(item.toolCall.input));
	const response = $derived(truncatedJson(item.toolCall.structured ?? item.toolCall.result));
</script>

<details class="group my-1 text-xs">
	<summary
		class="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-default px-1.5 text-muted marker:hidden hover:bg-surface-hover"
	>
		<ToolCallLeadingIcons kind={item.toolCall.kind} />
		<span class="shrink-0 text-normal">MCP</span>
		<ToolActivityText text={toolTarget(item)} {active} class="min-w-0 flex-1 truncate font-mono" />
		<span class={cx('shrink-0 text-2xs', visual.text)}>{visual.label}</span>
		{#if item.durationMs !== undefined}<span class="font-mono text-2xs text-faint"
				>{formatToolDuration(item.durationMs)}</span
			>{/if}
	</summary>
	<div class="ml-6 grid gap-2 py-1 pr-2">
		<section>
			<h4 class="mb-1 text-2xs tracking-wide text-faint uppercase">请求</h4>
			<pre
				class="scroll-thin max-h-52 overflow-auto rounded-default bg-surface-active p-2 font-mono text-xs leading-5 whitespace-pre-wrap text-normal">{request.text}</pre>
			{#if request.truncated}<p class="mt-1 text-2xs text-status-waiting">
					请求 JSON 已截断。
				</p>{/if}
		</section>
		<section>
			<h4 class="mb-1 text-2xs tracking-wide text-faint uppercase">响应</h4>
			<pre
				class={cx(
					'scroll-thin max-h-64 overflow-auto rounded-default bg-surface-active p-2 font-mono text-xs leading-5 whitespace-pre-wrap',
					item.toolCall.error ? 'text-status-error' : 'text-normal'
				)}>{response.text}</pre>
			{#if response.truncated}<p class="mt-1 text-2xs text-status-waiting">
					响应 JSON 已截断。
				</p>{/if}
		</section>
	</div>
</details>
