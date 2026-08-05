<script lang="ts">
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { sessionWorkspace } from '$lib/features/session/session-workspace.svelte';
	import {
		collectSessionChanges,
		type SessionFileChange
	} from '$lib/features/session/session-changes';
	import FileDiff from '$lib/ui/diff/FileDiff.svelte';

	const changes = $derived(collectSessionChanges(sessionWorkspace.timeline));
	const totalFiles = $derived(changes.length);
	const totalAdditions = $derived(changes.reduce((sum, file) => sum + file.additions, 0));
	const totalDeletions = $derived(changes.reduce((sum, file) => sum + file.deletions, 0));

	const KIND_LABELS: Record<SessionFileChange['kind'], string> = {
		create: '新增',
		modify: '修改',
		delete: '删除',
		rename: '重命名'
	};
</script>

{#if !sessionWorkspace.selectedSession}
	<EmptyState title="尚未选择会话" description="选择一个会话后查看它做出的全部文件更改。" compact>
		{#snippet icon()}<Icon name="file-text" size={16} />{/snippet}
	</EmptyState>
{:else if changes.length === 0}
	<EmptyState title="暂无变更" description="这个会话还没有修改任何文件。" compact>
		{#snippet icon()}<Icon name="file-text" size={16} />{/snippet}
	</EmptyState>
{:else}
	<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
		<div class="flex h-8 shrink-0 items-center gap-2 border-b border-subtle px-2.5 text-2xs text-faint">
			<span>{totalFiles} 个文件</span>
			<span class="font-mono text-status-completed">+{totalAdditions}</span>
			<span class="font-mono text-status-error">−{totalDeletions}</span>
		</div>

		<div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
			{#each changes as file (file.path)}
				<details class="group border-b border-subtle last:border-b-0">
					<summary
						class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2 text-xs marker:hidden hover:bg-surface-hover"
					>
						<span
							class="text-2xs text-faint transition-transform group-open:rotate-90"
							aria-hidden="true">▶</span
						>
						<span class="shrink-0 text-2xs text-muted">{KIND_LABELS[file.kind]}</span>
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
						{#if file.revisions.length === 1}
							<FileDiff file={file.revisions[0]!.file} maxHeight="24rem" />
						{:else}
							<!-- 同一文件被多次修改:逐次展示,避免把不同坐标系的 hunk 拼成一个假 diff。 -->
							{#each file.revisions as revision, index (revision.changeSetId)}
								<div class="border-b border-subtle last:border-b-0">
									<p
										class="flex items-center gap-2 bg-surface-panel px-2 py-1 text-2xs text-faint"
									>
										<span>第 {index + 1} 次修改</span>
										<span class="font-mono">seq {revision.sequence}</span>
									</p>
									<FileDiff file={revision.file} maxHeight="20rem" />
								</div>
							{/each}
						{/if}
					</div>
				</details>
			{/each}
		</div>
	</div>
{/if}
