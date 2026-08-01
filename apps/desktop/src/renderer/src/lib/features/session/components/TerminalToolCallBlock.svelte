<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';
	import { TOOL_STATUS } from '$lib/shared/utils/status';
	import type { ConversationToolCall } from '../projection';
	import ToolActivityText from './ToolActivityText.svelte';
	import {
		formatToolDuration,
		isActiveTool,
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
	const command = $derived(toolTarget(item));
	const output = $derived(toolResultText(item));
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
		<span class="shrink-0 text-normal">运行</span>
		<ToolActivityText text={command} {active} class="min-w-0 truncate font-mono" />
		{#if !active && summary}<span class="min-w-0 flex-1 truncate text-faint">— {summary}</span
			>{:else}<span class="flex-1"></span>{/if}
		<span class={cx('shrink-0 text-2xs', visual.text)}>{visual.label}</span>
		{#if item.durationMs !== undefined}<span class="font-mono text-2xs text-faint"
				>{formatToolDuration(item.durationMs)}</span
			>{/if}
	</summary>
	<div class="ml-6 grid gap-2 py-1 pr-2">
		<section>
			<h4 class="mb-1 text-2xs tracking-wide text-faint uppercase">命令</h4>
			<pre
				class="scroll-thin overflow-x-auto rounded-default bg-surface-active p-2 font-mono text-xs leading-5 whitespace-pre text-strong">{command}</pre>
		</section>
		<section>
			<h4 class="mb-1 text-2xs tracking-wide text-faint uppercase">输出</h4>
			{#if output}
				<pre
					class={cx(
						'scroll-thin max-h-80 overflow-auto rounded-default bg-surface-active p-2 font-mono text-xs leading-5 whitespace-pre-wrap',
						item.toolCall.error ? 'text-status-error' : 'text-normal'
					)}>{output}</pre>
			{:else}<p class="rounded-default bg-surface-active px-2 py-1.5 text-faint">
					{active ? '命令正在运行…' : '命令没有输出。'}
				</p>{/if}
		</section>
	</div>
</details>
