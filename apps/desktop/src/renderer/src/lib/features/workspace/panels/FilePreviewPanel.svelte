<script lang="ts">
	import { filePreview } from '$lib/features/files/file-preview.svelte';
	import {
		highlightCode,
		languageFromPath
	} from '$lib/features/session/markdown/highlight';
	import '$lib/features/session/markdown/hljs-theme.css';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	const path = $derived(filePreview.path);
	const status = $derived(filePreview.status);
	const content = $derived(filePreview.content);
	const error = $derived(filePreview.error);
	const language = $derived(path ? languageFromPath(path) : 'plaintext');
	const highlighted = $derived(highlightCode(content, language));
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
			<p class="m-2 shrink-0 rounded-default bg-cinnabar-500/8 px-2 py-1.5 text-2xs text-status-error">
				{error ?? '无法读取文件'}
			</p>
		{:else if status === 'loading'}
			<p class="shrink-0 px-2 py-2 text-2xs text-faint">正在读取文件…</p>
		{:else}
			<div class="agent-code scroll-thin min-h-0 flex-1 overflow-auto bg-surface-raised">
				<pre
					class="m-0 p-2 text-xs leading-5 whitespace-pre"
				><!-- highlight.js escapes the source text before returning markup. --><!-- eslint-disable-next-line svelte/no-at-html-tags --><code
						class={`hljs language-${language} font-mono`}>{@html highlighted}</code
					></pre>
			</div>
		{/if}
	</div>
{/if}
