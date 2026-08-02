<script lang="ts">
	/**
	 * Dev 性能工具集合:自研 PerfHud + svelte-render-scan(渲染热点高亮)。
	 * render-scan 用动态 import,确保生产包不加载该 dev 依赖。
	 */
	import PerfHud from '$lib/shared/perf/PerfHud.svelte';
	import type { RenderScan as RenderScanComponent } from 'svelte-render-scan';

	let RenderScan: typeof RenderScanComponent | undefined = $state();

	$effect(() => {
		if (!import.meta.env.DEV) return;
		import('svelte-render-scan').then((module) => {
			RenderScan = module.RenderScan;
		});
	});
</script>

{#if RenderScan}
	<RenderScan />
{/if}
<PerfHud />
