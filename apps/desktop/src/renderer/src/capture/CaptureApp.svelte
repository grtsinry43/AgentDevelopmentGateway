<script lang="ts">
	/**
	 * 后台导出捕获页(隐藏 offscreen 窗口)。用真实组件全量渲染对话,
	 * 渲染后上报内容高度,供主进程 printToPDF / capturePage。用户不可见。
	 */
	import { onMount } from 'svelte';
	import { forceLightTheme } from '$lib/shared/theme/theme.svelte';
	import { desktop } from '$lib/shared/bridge/desktop';
	import type { ExportConversationPayload } from '$contract/bridge';
	import type { ConversationTimelineItem } from '$lib/features/session/projection';
	import ConversationTranscript from '$lib/features/session/components/ConversationTranscript.svelte';

	// 导出固定浅色主题 + 纯色背景,不跟随系统、不带装饰底纹。
	forceLightTheme();

	let payload = $state<ExportConversationPayload | null>(null);
	const rawItems = $derived(
		payload ? (payload.items as unknown as ConversationTimelineItem[]) : []
	);

	onMount(async () => {
		payload = await desktop.export.getData();
		// 全量渲染 + 字体加载完后再上报高度:主进程据此分块滚动截图,提前上报会截到未排版内容。
		await document.fonts.ready;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await desktop.export.rendered(document.documentElement.scrollHeight);
	});
</script>

{#if payload}
	<div class="flex min-h-screen flex-col" style="background:#fafaf9;color:#292524">
		<div class="mx-auto w-full max-w-3xl px-5 pt-6">
			<h1 class="text-base font-medium" style="color:#1c1917">{payload.projectName}</h1>
			<div class="mt-0.5 font-mono text-2xs" style="color:#78716c">
				{payload.sessionTitle ?? ''}
			</div>
		</div>
		<ConversationTranscript items={rawItems} />
		<div class="mx-auto w-full max-w-3xl px-5 py-4 text-right text-2xs" style="color:#a8a29e">
			Agent Development Gateway
		</div>
	</div>
{/if}
