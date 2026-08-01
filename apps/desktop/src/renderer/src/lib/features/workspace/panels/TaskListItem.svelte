<script lang="ts">
	import type { TaskItem } from '@agent-gateway/core';
	import { TASK_STATUS } from '$lib/shared/utils/status';

	interface Props {
		task: TaskItem;
		tasks: TaskItem[];
	}

	let { task, tasks }: Props = $props();

	const visual = $derived(TASK_STATUS[task.status]);
	const label = $derived(
		task.status === 'in_progress' && task.activeText ? task.activeText : task.title
	);
	const blockers = $derived(
		(task.blockedBy ?? []).map((id) => tasks.find((entry) => entry.id === id)).filter(Boolean)
	);
	const unresolvedBlockerCount = $derived(
		(task.blockedBy ?? []).filter((id) => {
			const blocker = tasks.find((entry) => entry.id === id);
			return !blocker || (blocker.status !== 'completed' && blocker.status !== 'cancelled');
		}).length
	);
	const hasDetails = $derived(
		Boolean(
			task.description ||
			task.owner ||
			task.priority ||
			(task.blockedBy?.length ?? 0) > 0 ||
			(task.blocks?.length ?? 0) > 0
		)
	);
</script>

<details
	class="group/task border-b border-subtle last:border-b-0"
	open={task.status === 'in_progress'}
>
	<summary
		class="flex min-h-row cursor-default list-none items-start gap-2 px-2.5 py-1.5 select-none marker:hidden hover:bg-surface-hover"
	>
		<span
			class="mt-[3px] flex size-3 shrink-0 items-center justify-center rounded-full border border-current {visual.text}"
			aria-label={visual.label}
		>
			{#if task.status === 'completed'}
				<span class="size-1.5 rounded-full {visual.dot}"></span>
			{:else if task.status === 'in_progress'}
				<span class="size-1.5 animate-pulse rounded-full {visual.dot}"></span>
			{/if}
		</span>

		<span class="min-w-0 flex-1">
			<span
				class="block text-xs leading-4 {task.status === 'completed' || task.status === 'cancelled'
					? 'text-faint line-through'
					: 'text-normal'}"
			>
				{label}
			</span>
			{#if unresolvedBlockerCount > 0}
				<span class="block text-2xs text-status-waiting"
					>被 {unresolvedBlockerCount} 个任务阻塞</span
				>
			{/if}
		</span>

		{#if task.priority}
			<span class="mt-px font-mono text-2xs text-faint uppercase">{task.priority}</span>
		{/if}
		{#if hasDetails}
			<span class="mt-0.5 text-2xs text-faint transition-transform group-open/task:rotate-90"
				>›</span
			>
		{/if}
	</summary>

	{#if hasDetails}
		<div class="space-y-1 pr-2.5 pb-2 pl-7 text-2xs leading-4 text-muted">
			{#if task.description}<p>{task.description}</p>{/if}
			{#if task.owner}<p><span class="text-faint">负责人</span> {task.owner}</p>{/if}
			{#if blockers.length > 0}
				<p>
					<span class="text-faint">依赖</span>
					{blockers.map((entry) => entry?.title).join('、')}
				</p>
			{/if}
			{#if task.blocks?.length}
				<p><span class="text-faint">阻塞后续</span> {task.blocks.length} 项</p>
			{/if}
		</div>
	{/if}
</details>
