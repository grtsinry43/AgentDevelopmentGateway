<script lang="ts">
	/**
	 * Dev 性能工具集合:自研 PerfHud(⌥⌘P / 状态栏开关)+ 自实现渲染热点高亮。
	 * 渲染热点用独立 MutationObserver(render-scan.svelte.ts 开关),不复用 svelte-render-scan 的 UI。
	 */
	import PerfHud from '$lib/shared/perf/PerfHud.svelte';
	import RenderScanOverlay from '$lib/shared/perf/RenderScanOverlay.svelte';
	import { renderScan } from '$lib/shared/perf/render-scan.svelte';
</script>

<PerfHud />
{#if renderScan.enabled}
	<RenderScanOverlay />
{/if}
