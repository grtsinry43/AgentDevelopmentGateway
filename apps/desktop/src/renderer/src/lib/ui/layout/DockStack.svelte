<script lang="ts">
	/**
	 * 右侧 dock:垂直堆叠的面板,可拖拽调整相邻两个的高度比、可折叠、可关闭。
	 *
	 * 刻意不做自由浮动/任意分割(golden-layout 那种)。能力收缩换来的是:
	 * 布局可被 ⌘1..9 键盘寻址,状态可完整序列化,实现只有一百多行。
	 */
	import { getPanel } from '$lib/shared/registry/panels';
	import { layout } from '$lib/features/workspace/layout.svelte';
	import DockPanel from './DockPanel.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		/** 当前键盘聚焦的面板 id。 */
		focusedId?: string;
	}

	let { focusedId }: Props = $props();

	/** 已注册的面板 + 其定义。未注册的 type(比如旧布局残留)静默跳过。 */
	const resolved = $derived(
		layout.panels
			.map((state) => ({ state, definition: getPanel(state.type) }))
			.filter(
				(
					entry
				): entry is {
					state: typeof entry.state;
					definition: NonNullable<typeof entry.definition>;
				} => Boolean(entry.definition)
			)
	);

	let container = $state<HTMLElement | null>(null);

	/**
	 * 拖动相邻两面板之间的分隔条:把 delta 转成两者的权重再分配。
	 * 总权重守恒,所以只影响这两个面板,不会挤压其他的。
	 */
	function resizePair(index: number, deltaPx: number): void {
		const current = resolved[index];
		const next = resolved[index + 1];
		if (!current || !next || !container) return;

		const totalWeight = current.state.weight + next.state.weight;
		// 可伸缩的总高度 ≈ 容器高度(折叠的面板不参与,误差可接受)
		const available = container.clientHeight;
		if (available <= 0) return;

		const deltaWeight = (deltaPx / available) * totalWeight;
		const MIN = 0.15;
		const nextCurrent = Math.min(
			totalWeight - MIN,
			Math.max(MIN, current.state.weight + deltaWeight)
		);

		layout.setPanelWeights(current.state.id, nextCurrent, next.state.id, totalWeight - nextCurrent);
	}
</script>

{#if resolved.length === 0}
	<EmptyState title="没有打开的面板" description="使用上方工具栏添加面板。" compact>
		{#snippet icon()}
			<Icon name="layers" size={18} />
		{/snippet}
	</EmptyState>
{:else}
	<div bind:this={container} class="flex min-h-0 flex-1 flex-col">
		{#each resolved as entry, index (entry.state.id)}
			<div
				class="flex min-h-0 flex-col"
				style:flex-grow={entry.state.collapsed ? 0 : entry.state.weight}
				style:flex-basis={entry.state.collapsed ? 'auto' : '0'}
			>
				<DockPanel
					title={entry.definition.title}
					icon={entry.definition.icon}
					collapsed={entry.state.collapsed}
					ordinal={index + 1}
					focused={entry.state.id === focusedId}
					ontoggle={() => layout.togglePanel(entry.state.id)}
					onclose={() => layout.removePanel(entry.state.id)}
				>
					<entry.definition.component />
				</DockPanel>
			</div>

			<!-- 最后一个面板下方不需要分隔条;折叠的面板高度不可调 -->
			{#if index < resolved.length - 1 && !entry.state.collapsed}
				<ResizeHandle
					orientation="horizontal"
					label="调整 {entry.definition.title} 高度"
					onDrag={(delta) => resizePair(index, delta)}
				/>
			{/if}
		{/each}
	</div>
{/if}
