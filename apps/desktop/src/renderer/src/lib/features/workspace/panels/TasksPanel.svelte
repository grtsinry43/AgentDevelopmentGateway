<script lang="ts">
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import { sessionWorkspace } from '$lib/features/session/session-workspace.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import TaskListItem from './TaskListItem.svelte';

	const progress = $derived(sessionWorkspace.taskProgress);
</script>

{#if !sessionWorkspace.selectedSession}
	<EmptyState title="尚未选择会话" description="选择一个会话后查看 Agent 的任务。" compact>
		{#snippet icon()}<Icon name="list" size={16} />{/snippet}
	</EmptyState>
{:else if sessionWorkspace.tasks.length === 0}
	<EmptyState title="暂无任务" description="Agent 创建计划或待办后会显示在这里。" compact>
		{#snippet icon()}<Icon name="list" size={16} />{/snippet}
	</EmptyState>
{:else}
	<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
		<div class="flex items-center gap-2 border-b border-subtle px-2.5 py-1.5 text-2xs text-faint">
			<span>{progress.completed} / {progress.total} 已完成</span>
			<div class="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-active">
				<div
					class="h-full rounded-full bg-status-completed transition-[width] duration-200"
					style:width={`${progress.total === 0 ? 0 : (progress.completed / progress.total) * 100}%`}
				></div>
			</div>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#each sessionWorkspace.tasks as task (task.id)}
				<TaskListItem {task} tasks={sessionWorkspace.tasks} />
			{/each}
		</div>
	</div>
{/if}
