<script lang="ts">
	/**
	 * 最近工程列表。
	 */
	import { launcher } from '../launcher.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import RecentProjectCard from './RecentProjectCard.svelte';

	const projects = $derived(launcher.filtered);

	/** 选中项滚进视野。键盘导航到列表底部时列表必须跟着走。 */
	function scrollIntoView(node: HTMLElement, selected: boolean) {
		if (selected) node.scrollIntoView({ block: 'nearest' });
	}
</script>

{#if launcher.loading}
	<EmptyState title="读取最近工程…" compact />
{:else if launcher.error}
	<EmptyState title="读取失败" description={launcher.error} compact />
{:else if projects.length === 0}
	<EmptyState
		title={launcher.query ? '没有匹配的工程' : '还没有工程'}
		description={launcher.query
			? '试试改一下关键字,名称、路径和主机都参与匹配。'
			: '按 ⌘N 添加本地工程,或 ⌘⇧N 添加远程工程。'}
	>
		{#snippet icon()}
			<Icon name="folder" size={22} />
		{/snippet}
	</EmptyState>
{:else}
	<div class="border-t border-subtle">
		{#each projects as project, index (project.key)}
			<div {@attach (node) => scrollIntoView(node, index === launcher.cursor)}>
				<RecentProjectCard
					{project}
					selected={index === launcher.cursor}
					onactivate={() => {
						launcher.setCursor(index);
						void launcher.openSelected();
					}}
				/>
			</div>
		{/each}
	</div>
{/if}
