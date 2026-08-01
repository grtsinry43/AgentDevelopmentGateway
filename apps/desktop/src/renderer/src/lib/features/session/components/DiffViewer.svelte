<script lang="ts" module>
	import type { ChangeSetWire } from '@agent-gateway/shared';

	type FileChange = ChangeSetWire['files'][number];

	const CHANGE_LABELS: Record<FileChange['kind'], string> = {
		create: '新增',
		modify: '修改',
		delete: '删除',
		rename: '重命名'
	};
</script>

<script lang="ts">
	import FileDiff from '$lib/ui/diff/FileDiff.svelte';
	interface Props {
		changeSet: ChangeSetWire;
	}

	let { changeSet }: Props = $props();
	const additions = $derived(changeSet.files.reduce((total, file) => total + file.additions, 0));
	const deletions = $derived(changeSet.files.reduce((total, file) => total + file.deletions, 0));
</script>

<div class="min-w-0 overflow-hidden rounded-default border border-subtle bg-surface-panel">
	<div class="flex h-8 items-center gap-2 border-b border-subtle px-2 text-2xs text-faint">
		{#if changeSet.files.length === 1}
			<code class="min-w-0 flex-1 truncate font-mono text-normal">
				{changeSet.files[0]?.previousPath ? `${changeSet.files[0]?.previousPath} → ` : ''}{changeSet
					.files[0]?.path}
			</code>
		{:else}
			<span class="flex-1">{changeSet.files.length} 个文件</span>
		{/if}
		<span class="font-mono text-status-completed">+{additions}</span>
		<span class="font-mono text-status-error">−{deletions}</span>
		<span>{changeSet.intent === 'proposed' ? '待审批' : '已应用'}</span>
	</div>

	{#each changeSet.files as file, fileIndex (`${file.path}:${fileIndex}`)}
		<details
			class="group/file border-b border-subtle last:border-b-0"
			open={changeSet.files.length === 1}
		>
			<summary
				class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2 text-xs marker:hidden hover:bg-surface-hover data-[single=true]:hidden"
				data-single={changeSet.files.length === 1}
			>
				<span
					class="text-2xs text-faint transition-transform group-open/file:rotate-90"
					aria-hidden="true">▶</span
				>
				<span class="shrink-0 text-2xs text-muted">{CHANGE_LABELS[file.kind]}</span>
				<code class="min-w-0 flex-1 truncate font-mono text-normal">
					{file.previousPath ? `${file.previousPath} → ` : ''}{file.path}
				</code>
				{#if file.pathKind === 'absolute'}
					<span class="shrink-0 text-2xs text-status-waiting">工作区外</span>
				{/if}
				<span class="shrink-0 font-mono text-2xs text-status-completed">+{file.additions}</span>
				<span class="shrink-0 font-mono text-2xs text-status-error">−{file.deletions}</span>
			</summary>

			<div class="border-t border-subtle">
				<FileDiff {file} />
			</div>
		</details>
	{/each}
</div>
