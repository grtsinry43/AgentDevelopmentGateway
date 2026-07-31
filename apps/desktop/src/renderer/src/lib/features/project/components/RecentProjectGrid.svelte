<script lang="ts">
	/**
	 * 最近工程网格。
	 *
	 * 网格 + 键盘导航的坑:↑↓ 应该跨行移动(± 列数),而不是 ±1。列数是响应式的
	 * (窗口宽度决定),所以要实测而不是硬编码 —— 用 ResizeObserver 量一行放几张。
	 */
	import { launcher } from '../launcher.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import RecentProjectCard from './RecentProjectCard.svelte';

	interface Props {
		/** 由父组件传入实测列数,供 keymap 计算 ↑↓ 步长。 */
		oncolumnschange?: (columns: number) => void;
	}

	let { oncolumnschange }: Props = $props();

	const projects = $derived(launcher.filtered);

	/** 实测列数。CSS grid 的列数由 auto-fill 决定,JS 侧只能量出来。 */
	function measureColumns(node: HTMLElement) {
		const observer = new ResizeObserver(() => {
			const first = node.firstElementChild as HTMLElement | null;
			if (!first) return;
			const columns = Math.max(1, Math.round(node.clientWidth / first.offsetWidth));
			oncolumnschange?.(columns);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}

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
	<div
		{@attach measureColumns}
		class="grid gap-2.5"
		style:grid-template-columns="repeat(auto-fill, minmax(15rem, 1fr))"
	>
		{#each projects as project, index (project.key)}
			<div {@attach (node) => scrollIntoView(node, index === launcher.cursor)}>
				<RecentProjectCard
					{project}
					selected={index === launcher.cursor}
					onactivate={() => {
						launcher.setCursor(index);
						void launcher.openSelected();
					}}
					onhover={() => launcher.setCursor(index)}
				/>
			</div>
		{/each}
	</div>
{/if}
