<script lang="ts">
	import type { GitChange } from '@agent-gateway/shared';
	import { changeKey, type GitWorkspace } from '$lib/features/git/git-workspace.svelte';
	import GitChangeRow from './GitChangeRow.svelte';

	interface Props {
		title: string;
		changes: GitChange[];
		workspace: GitWorkspace;
	}

	let { title, changes, workspace }: Props = $props();
	const allStaged = $derived(changes.every((change) => change.area === 'staged'));
	const paths = $derived(changes.map((change) => change.path));
</script>

{#if changes.length > 0}
	<section>
		<div class="flex h-6 items-center border-y border-subtle bg-surface-raised px-2">
			<span class="min-w-0 flex-1 truncate text-2xs font-medium text-muted">{title}</span>
			<span class="mr-1 font-mono text-[9px] text-faint">{changes.length}</span>
			<button
				type="button"
				class="grid h-5 w-5 place-items-center rounded-default text-xs text-muted hover:bg-surface-hover hover:text-strong"
				title={allStaged ? '全部取消暂存' : '全部暂存'}
				disabled={workspace.activeOperation !== undefined}
				onclick={() => void (allStaged ? workspace.unstage(paths) : workspace.stage(paths))}
			>
				{allStaged ? '−' : '+'}
			</button>
		</div>
		{#each changes as change (changeKey(change))}
			{@const key = changeKey(change)}
			<GitChangeRow
				{change}
				expanded={workspace.selectedChangeKey === key}
				diff={workspace.selectedChangeKey === key ? workspace.selectedDiff : undefined}
				diffLoading={workspace.selectedChangeKey === key && workspace.diffLoading}
				disabled={workspace.activeOperation !== undefined}
				onToggle={() => void workspace.toggleDiff(change)}
				onAction={() =>
					void (change.area === 'staged'
						? workspace.unstage([change.path])
						: workspace.stage([change.path]))}
			/>
		{/each}
	</section>
{/if}
