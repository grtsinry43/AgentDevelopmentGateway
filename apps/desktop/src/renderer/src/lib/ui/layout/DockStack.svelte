<script lang="ts">
	/**
	 * 右侧 dock 内容区:单槽 tab 或上下拆分(最多 2)。
	 * 图标条与拖拽拆分由 ProjectApp / RightToolRail / DockDropOverlay 负责。
	 */
	import { getPanel } from '$lib/shared/registry/panels';
	import { layout } from '$lib/features/workspace/layout.svelte';
	import DockPanel from './DockPanel.svelte';
	import ResizeHandle from './ResizeHandle.svelte';

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
	<div class="relative min-h-0 flex-1"></div>
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
					contentOverflow={entry.definition.contentOverflow}
					ontoggle={() => layout.togglePanel(entry.state.id)}
					onclose={() => layout.removePanel(entry.state.id)}
				>
					<entry.definition.component />
				</DockPanel>
			</div>

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
