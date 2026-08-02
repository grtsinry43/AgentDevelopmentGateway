<script lang="ts">
	/**
	 * 导出对话框窗口:左侧实时预览(真实对话组件),右侧选导出格式。
	 * 实际导出由主进程在后台 offscreen 窗口完成,这里只负责确认。
	 */
	import { onMount } from 'svelte';
	import { forceLightTheme } from '$lib/shared/theme/theme.svelte';
	import { desktop, systemInfo } from '$lib/shared/bridge/desktop';
	import type { ExportConversationPayload, ExportFormat } from '$contract/bridge';
	import type { ConversationTimelineItem } from '$lib/features/session/projection';
	import ConversationTranscript from '$lib/features/session/components/ConversationTranscript.svelte';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	// 导出固定浅色主题:预览与产物一致,纯色背景。
	forceLightTheme();

	let payload = $state<ExportConversationPayload | null>(null);
	let format = $state<ExportFormat>('png');
	let exporting = $state(false);
	let error = $state<string | undefined>(undefined);
	let done = $state(false);

	const rawItems = $derived(
		payload ? (payload.items as unknown as ConversationTimelineItem[]) : []
	);

	onMount(async () => {
		payload = await desktop.export.getData();
	});

	async function doExport(): Promise<void> {
		if (!payload || exporting) return;
		exporting = true;
		error = undefined;
		done = false;
		try {
			await desktop.export.commit(format);
			done = true;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			exporting = false;
		}
	}

	function cancel(): void {
		void desktop.window.close();
	}
</script>

<div class="flex h-full flex-col overflow-hidden bg-[#fafaf9]">
	<TitleBar title="导出对话" />

	<main class="flex min-h-0 flex-1">
		<!-- 左:预览(真实渲染) -->
		<section class="scroll-thin min-w-0 flex-1 overflow-y-auto border-r border-subtle">
			<div class="mx-auto w-full max-w-3xl px-5 py-4">
				{#if payload}
					<ConversationTranscript items={rawItems} />
				{:else}
					<p class="py-4 text-center text-2xs text-faint">没有可导出的内容。</p>
				{/if}
			</div>
		</section>

		<!-- 右:格式 -->
		<aside class="flex w-52 shrink-0 flex-col p-3">
			<span class="text-2xs text-muted">导出格式</span>
			<div class="mt-2 flex flex-col gap-1">
				{#each [{ value: 'png', label: '图片 (PNG)', hint: '长图,保留原样' }, { value: 'pdf', label: 'PDF', hint: '分页文档' }] as opt (opt.value)}
					<button
						type="button"
						class={[
							'flex flex-col items-start gap-0.5 rounded-default border px-2.5 py-2 text-left transition-colors',
							format === opt.value
								? 'border-line-accent bg-surface-active'
								: 'border-line hover:bg-surface-hover'
						]}
						onclick={() => (format = opt.value as ExportFormat)}
					>
						<span class="flex items-center gap-1.5 text-xs text-strong">
							<Icon name="download" size={11} />
							{opt.label}
						</span>
						<span class="text-2xs text-faint">{opt.hint}</span>
					</button>
				{/each}
			</div>

			{#if error}
				<p class="mt-2 text-2xs text-cinnabar-600 dark:text-cinnabar-400">{error}</p>
			{/if}
			{#if done}
				<p class="mt-2 text-2xs text-status-online">已导出,可再次导出其他格式。</p>
			{/if}

			<div class="mt-auto flex flex-col gap-1 pt-3">
				<Button variant="primary" fullWidth loading={exporting} onclick={() => void doExport()}>
					导出
				</Button>
				<Button variant="ghost" fullWidth onclick={cancel}>取消</Button>
			</div>
		</aside>
	</main>
</div>

{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
