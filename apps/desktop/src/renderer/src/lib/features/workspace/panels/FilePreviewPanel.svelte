<script lang="ts">
	import { filePreview, type FilePreviewRange } from '$lib/features/files/file-preview.svelte';
	import { highlightCode, languageFromPath } from '$lib/features/session/markdown/highlight';
	import '$lib/features/session/markdown/hljs-theme.css';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { cx } from '$lib/shared/utils/cx';

	const path = $derived(filePreview.path);
	const status = $derived(filePreview.status);
	const content = $derived(filePreview.content);
	const error = $derived(filePreview.error);
	const range = $derived(filePreview.range);
	const language = $derived(path ? languageFromPath(path) : 'plaintext');
	const lines = $derived(content === '' ? [] : content.split('\n'));

	/** 该行(1-based)是否落在打开时携带的行号区间内。 */
	function lineInRange(line: number, range: FilePreviewRange | null): boolean {
		if (!range) return false;
		if (range.startLine !== undefined && range.endLine !== undefined) {
			return line >= range.startLine && line <= range.endLine;
		}
		return range.line === line;
	}

	/** 滚动容器:打开后定位到区间首行。 */
	let scrollEl: HTMLDivElement | undefined;
	$effect(() => {
		if (!scrollEl || status !== 'ready' || !range) return;
		const start = range.startLine ?? range.line;
		if (start === undefined) return;
		const lineEl = scrollEl.querySelector(`[data-line="${start}"]`);
		lineEl?.scrollIntoView({ block: 'center' });
	});
</script>

{#if !path && status === 'idle'}
	<div class="h-full min-h-0">
		<EmptyState title="文件预览" description="从对话中的文件引用打开。" compact>
			{#snippet icon()}
				<Icon name="file-text" size={16} />
			{/snippet}
		</EmptyState>
	</div>
{:else}
	<div class="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
		<div
			class="flex h-7 shrink-0 items-center gap-1.5 border-b border-subtle px-2 text-2xs text-muted"
		>
			<Icon name="file-text" size={12} class="shrink-0 text-faint" />
			<span class="min-w-0 flex-1 truncate font-mono" title={path ?? undefined}>{path}</span>
			{#if range}
				<span class="shrink-0 font-mono text-faint">
					{range.startLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.line}`}
				</span>
			{/if}
			{#if status === 'loading'}
				<span class="shrink-0 text-faint">读取中…</span>
			{/if}
			<button
				type="button"
				class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-default text-faint hover:bg-surface-hover hover:text-normal"
				aria-label="关闭预览"
				onclick={() => filePreview.clear()}
			>
				<Icon name="close" size={12} />
			</button>
		</div>

		{#if status === 'error'}
			<p
				class="m-2 shrink-0 rounded-default bg-cinnabar-500/8 px-2 py-1.5 text-2xs text-status-error"
			>
				{error ?? '无法读取文件'}
			</p>
		{:else if status === 'loading'}
			<p class="shrink-0 px-2 py-2 text-2xs text-faint">正在读取文件…</p>
		{:else}
			<div
				class="agent-code scroll-thin min-h-0 flex-1 overflow-auto bg-surface-raised"
				bind:this={scrollEl}
			>
				<div class="min-w-max">
					{#each lines as line, index (index)}
						{@const lineNumber = index + 1}
						<div
							class={cx(
								'flex items-start whitespace-pre',
								lineInRange(lineNumber, range) && 'bg-jade-500/12'
							)}
							data-line={lineNumber}
						>
							<span
								class="w-10 shrink-0 pr-3 text-right font-mono text-2xs leading-5 text-faint select-none"
								>{lineNumber}</span
							>
							<code class={`hljs language-${language} font-mono text-xs leading-5 whitespace-pre`}>
								<!-- highlight.js escapes the source text before returning markup. -->
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								{@html highlightCode(line, language)}
							</code>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}
