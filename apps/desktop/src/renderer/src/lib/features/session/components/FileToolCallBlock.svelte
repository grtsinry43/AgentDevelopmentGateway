<script lang="ts">
	import { filePreview } from '$lib/features/files/file-preview.svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { TOOL_STATUS } from '$lib/shared/utils/status';
	import type { ConversationToolCall } from '../projection';
	import { DEFAULT_EXPAND_FILE_TOOL_DIFF } from '../preferences';
	import DiffViewer from './DiffViewer.svelte';
	import ToolActivityText from './ToolActivityText.svelte';
	import ToolCallLeadingIcons from './ToolCallLeadingIcons.svelte';
	import { formatToolDuration, isActiveTool, toolTarget } from './tool-display';

	interface Props {
		item: ConversationToolCall;
	}

	let { item }: Props = $props();
	const active = $derived(isActiveTool(item));
	const visual = $derived(TOOL_STATUS[active ? 'running' : item.toolCall.status]);
	const files = $derived(item.changeSet?.files ?? []);
	const additions = $derived(files.reduce((total, file) => total + file.additions, 0));
	const deletions = $derived(files.reduce((total, file) => total + file.deletions, 0));
	const operation = $derived(
		files.length === 1 && files[0]?.kind === 'create'
			? '写入'
			: files.length === 1 && files[0]?.kind === 'delete'
				? '删除'
				: '编辑'
	);
	const target = $derived(
		files.length === 1 ? (files[0]?.path ?? toolTarget(item)) : toolTarget(item)
	);
	const previewablePath = $derived(files.length === 1 ? (files[0]?.path ?? undefined) : undefined);

	function openPreview(event: MouseEvent): void {
		if (!previewablePath) return;
		event.preventDefault();
		event.stopPropagation();
		void filePreview.open(previewablePath);
	}
</script>

<details class="group my-1 text-xs" open={DEFAULT_EXPAND_FILE_TOOL_DIFF}>
	<summary
		class="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-default px-1.5 text-muted marker:hidden hover:bg-surface-hover"
	>
		<ToolCallLeadingIcons kind={item.toolCall.kind} />
		<span class="shrink-0 text-normal">{operation}</span>
		{#if previewablePath}
			<button
				type="button"
				class="min-w-0 flex-1 truncate text-left font-mono hover:text-accent hover:underline"
				title="预览文件"
				onclick={openPreview}
			>
				<ToolActivityText text={target} {active} class="block truncate" />
			</button>
		{:else}
			<ToolActivityText text={target} {active} class="min-w-0 flex-1 truncate font-mono" />
		{/if}
		{#if item.changeSet}
			<span class="shrink-0 font-mono text-2xs text-status-completed">+{additions}</span>
			<span class="shrink-0 font-mono text-2xs text-status-error">−{deletions}</span>
		{/if}
		<span class={cx('shrink-0 text-2xs', visual.text)}>{visual.label}</span>
		{#if item.durationMs !== undefined}
			<span class="shrink-0 font-mono text-2xs text-faint"
				>{formatToolDuration(item.durationMs)}</span
			>
		{/if}
	</summary>

	<div class="ml-6 py-1 pr-2">
		{#if item.changeSet}
			<DiffViewer changeSet={item.changeSet} />
		{:else if item.toolCall.error}
			<p class="rounded-default bg-cinnabar-500/8 px-2 py-1.5 text-status-error">
				{item.toolCall.error.message}
			</p>
		{:else}
			<p class="px-2 py-1 text-faint">{active ? '正在等待文件变更结果…' : '没有文件差异。'}</p>
		{/if}
	</div>
</details>
