<script lang="ts">
	/**
	 * 性能 HUD(dev 打点)。右上角悬浮,显示实时 FPS / 长任务 / DOM 节点 / 堆内存,
	 * 及自启动以来的 FPS min/avg/max。⌥⌘P 开关。
	 */
	import { perfMonitor } from '$lib/shared/perf/perf-monitor.svelte';

	let collapsed = $state(false);

	const stats = $derived.by(() => {
		const s = perfMonitor.samples;
		const last = s.at(-1);
		if (!last) return null;
		return {
			fps: perfMonitor.fps,
			min: perfMonitor.sessionMinFps,
			avg: perfMonitor.sessionAvgFps,
			max: perfMonitor.sessionMaxFps,
			longTasks: perfMonitor.longTasks,
			longestTaskMs: perfMonitor.longestTaskMs,
			domNodes: perfMonitor.domNodes,
			heapMB: perfMonitor.heapMB,
			points: s.slice(-60)
		};
	});

	const maxFpsScale = $derived(stats ? Math.max(stats.max, 30) : 30);
</script>

{#if perfMonitor.enabled}
	<div
		class="pointer-events-auto fixed top-10 right-2 z-[70] w-56 rounded-default border border-line bg-surface-raised p-2 font-mono text-2xs shadow-lg"
		role="status"
	>
		<div class="flex items-center justify-between">
			<span class="text-muted">性能监视</span>
			<button
				type="button"
				class="flex h-5 items-center rounded px-1.5 text-faint hover:bg-surface-hover hover:text-strong"
				onclick={() => (collapsed = !collapsed)}
			>
				{collapsed ? '展开' : '收起'}
			</button>
		</div>

		{#if stats}
			{#if !collapsed}
				<div class="mt-1.5 flex items-center gap-3">
					<span class="text-strong">FPS</span>
					<span class={perfMonitor.fps < 30 ? 'text-status-error' : 'text-normal'}>
						{stats.fps}
					</span>
					<span class="ml-auto text-faint">
						min {stats.min} · avg {stats.avg} · max {stats.max}
					</span>
				</div>

				<div class="mt-1 flex h-8 items-end gap-px">
					{#each stats.points as point (point.t)}
						<span
							class="min-w-0 flex-1 rounded-t-sm"
							class:bg-cinnabar-500={point.fps < 30}
							class:bg-amber-500={point.fps >= 30 && point.fps < 45}
							class:bg-jade-600={point.fps >= 45}
							style:height={`${Math.max((point.fps / maxFpsScale) * 100, 4)}%`}
						></span>
					{/each}
				</div>

				<div class="mt-1.5 flex flex-col gap-0.5 text-faint">
					<span>长任务: {stats.longTasks} 次 · 最长 {stats.longestTaskMs}ms</span>
					<span>DOM 节点: {stats.domNodes.toLocaleString()}</span>
					<span>堆内存: {stats.heapMB} MB</span>
				</div>
			{/if}
		{:else}
			<div class="mt-1 text-faint">采集中…</div>
		{/if}
	</div>
{/if}
