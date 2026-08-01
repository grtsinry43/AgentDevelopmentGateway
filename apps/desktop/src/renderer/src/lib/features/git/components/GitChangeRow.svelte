<script lang="ts" module>
	import type { GitChange, GitFileStatus } from '@agent-gateway/shared';

	const STATUS_LABELS: Record<GitFileStatus, string> = {
		added: 'A',
		modified: 'M',
		deleted: 'D',
		renamed: 'R',
		copied: 'C',
		'type-changed': 'T',
		unmerged: 'U',
		untracked: '?'
	};

	function statusClass(status: GitFileStatus): string {
		if (status === 'added' || status === 'untracked') return 'text-status-completed';
		if (status === 'deleted' || status === 'unmerged') return 'text-status-error';
		if (status === 'renamed' || status === 'copied') return 'text-accent';
		return 'text-status-waiting';
	}
</script>

<script lang="ts">
	import type { FileDiffChange } from '$lib/ui/diff/FileDiff.svelte';
	import FileDiff from '$lib/ui/diff/FileDiff.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';

	interface Props {
		change: GitChange;
		expanded: boolean;
		diff?: FileDiffChange;
		diffLoading?: boolean;
		disabled?: boolean;
		onToggle: () => void;
		onAction: () => void;
	}

	let {
		change,
		expanded,
		diff,
		diffLoading = false,
		disabled = false,
		onToggle,
		onAction
	}: Props = $props();
	const actionLabel = $derived(change.area === 'staged' ? '取消暂存' : '暂存');
</script>

<div class="group/change border-b border-subtle/60 last:border-b-0">
	<div class="flex h-6 min-w-0 items-center hover:bg-surface-hover">
		<button
			type="button"
			class="flex h-full min-w-0 flex-1 items-center gap-1 px-1.5 text-left outline-none focus-visible:shadow-[inset_2px_0_var(--focus-ring)]"
			title={change.previousPath ? `${change.previousPath} → ${change.path}` : change.path}
			onclick={onToggle}
		>
			<span class="w-2.5 shrink-0 text-[8px] text-faint">{expanded ? '▼' : '▶'}</span>
			<code class="min-w-0 flex-1 truncate font-mono text-2xs text-normal">{change.path}</code>
			{#if change.additions !== undefined}
				<span class="font-mono text-[9px] text-status-completed">+{change.additions}</span>
			{/if}
			{#if change.deletions !== undefined}
				<span class="font-mono text-[9px] text-status-error">−{change.deletions}</span>
			{/if}
			<span class={`w-3 shrink-0 text-center font-mono text-2xs ${statusClass(change.status)}`}>
				{STATUS_LABELS[change.status]}
			</span>
		</button>
		<button
			type="button"
			class="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-default text-xs text-muted opacity-0 transition-opacity group-hover/change:opacity-100 hover:bg-surface-selected hover:text-strong focus:opacity-100"
			title={actionLabel}
			aria-label={`${actionLabel} ${change.path}`}
			{disabled}
			onclick={onAction}
		>
			{change.area === 'staged' ? '−' : '+'}
		</button>
	</div>

	{#if expanded}
		<div class="border-t border-subtle bg-surface-base">
			{#if diffLoading}
				<div class="grid h-12 place-items-center text-faint">
					<Spinner size="sm" label="加载差异" />
				</div>
			{:else if diff}
				<FileDiff file={diff} maxHeight="18rem" />
			{:else}
				<p class="px-2 py-2 text-2xs text-faint">差异加载失败。</p>
			{/if}
		</div>
	{/if}
</div>
