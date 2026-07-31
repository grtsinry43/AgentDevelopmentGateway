<script lang="ts">
	import Icon, { type IconName } from '$lib/ui/icons/Icon.svelte';

	interface LauncherEntry {
		title: string;
		description: string;
		icon: IconName;
	}

	const entries: LauncherEntry[] = [
		{
			title: '规范与记忆',
			description: '管理工作约定与长期记忆',
			icon: 'file-text'
		},
		{
			title: '上下文与项目背景',
			description: '组织工程资料与上下文配置',
			icon: 'layers'
		},
		{
			title: '统计与监控',
			description: '查看运行状态与资源使用情况',
			icon: 'monitor'
		}
	];
</script>

<div class="border-t border-subtle">
	{#each entries as entry (entry.title)}
		<button
			type="button"
			disabled
			title={`${entry.title}尚未开放`}
			class="group flex w-full items-center gap-3 border-b border-subtle px-1 py-3 text-left disabled:cursor-default"
		>
			<span class="flex h-7 w-7 shrink-0 items-center justify-center text-faint">
				<Icon name={entry.icon} size={16} />
			</span>

			<span class="min-w-0 flex-1">
				<span class="block text-sm font-medium text-normal">{entry.title}</span>
				<span class="mt-0.5 block text-xs leading-4 text-faint">{entry.description}</span>
			</span>

			<span class="shrink-0 font-mono text-2xs tracking-wide text-faint">未开放</span>
		</button>
	{/each}
</div>
