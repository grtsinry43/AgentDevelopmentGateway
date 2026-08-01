<script lang="ts">
	import { highlightCode, normalizeCodeLanguage } from '../markdown/highlight';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		inline?: boolean;
		text?: string;
		lang?: string;
		attrs?: Record<string, string>;
		class?: string;
	}

	let { inline = false, text = '', lang, attrs = {}, class: className = '' }: Props = $props();
	let copied = $state(false);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

	const language = $derived(normalizeCodeLanguage(lang));
	const languageLabel = $derived(lang?.trim() || 'text');
	const highlighted = $derived(inline ? '' : highlightCode(text, language));
	const blockCodeClass = $derived(
		`agent-code__content hljs language-${language} block whitespace-pre font-mono`
	);

	async function copyCode(): Promise<void> {
		try {
			if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
			else if (!fallbackCopy(text)) throw new Error('Clipboard API unavailable');
			copied = true;
			if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => {
				copied = false;
				copyResetTimer = undefined;
			}, 1_200);
		} catch {
			copied = false;
		}
	}

	function fallbackCopy(value: string): boolean {
		const textarea = document.createElement('textarea');
		textarea.value = value;
		textarea.setAttribute('readonly', 'true');
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		document.body.appendChild(textarea);
		textarea.select();
		const copied = document.execCommand('copy');
		textarea.remove();
		return copied;
	}
</script>

{#if inline}
	<code
		{...attrs}
		class={`max-w-full rounded-default bg-surface-active px-1 py-0.5 font-mono text-[0.92em] break-words whitespace-pre-wrap ${className}`.trim()}
		>{text}</code
	>
{:else}
	<div
		class="agent-code my-3 max-w-full overflow-hidden rounded-default border border-subtle bg-surface-panel"
	>
		<div class="flex h-7 items-center border-b border-subtle px-2.5 text-2xs text-faint">
			<span class="truncate font-mono">{languageLabel}</span>
			<button
				type="button"
				class="ml-auto flex size-6 items-center justify-center rounded-default hover:bg-surface-hover hover:text-normal"
				aria-label={copied ? '已复制' : '复制代码'}
				title={copied ? '已复制' : '复制代码'}
				onclick={() => void copyCode()}
			>
				<Icon name={copied ? 'check' : 'copy'} size={12} />
			</button>
		</div>
		<div class="scroll-thin max-w-full overflow-x-auto bg-transparent p-3 text-xs leading-5">
			<!-- highlight.js escapes the source text before returning markup. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<code {...attrs} class={blockCodeClass}>{@html highlighted}</code>
		</div>
	</div>
{/if}

<style>
	.agent-code :global(.hljs) {
		color: var(--text-normal);
	}

	.agent-code :global(.hljs-comment),
	.agent-code :global(.hljs-quote) {
		color: var(--text-faint);
	}

	.agent-code :global(.hljs-keyword),
	.agent-code :global(.hljs-selector-tag),
	.agent-code :global(.hljs-literal),
	.agent-code :global(.hljs-deletion) {
		color: #d04a5d;
	}

	.agent-code :global(.hljs-string),
	.agent-code :global(.hljs-title),
	.agent-code :global(.hljs-section),
	.agent-code :global(.hljs-built_in),
	.agent-code :global(.hljs-addition) {
		color: #25845f;
	}

	.agent-code :global(.hljs-number),
	.agent-code :global(.hljs-symbol),
	.agent-code :global(.hljs-bullet) {
		color: #b76b35;
	}

	.agent-code :global(.hljs-attribute),
	.agent-code :global(.hljs-name),
	.agent-code :global(.hljs-selector-class) {
		color: #8663c6;
	}

	.agent-code :global(.hljs-type),
	.agent-code :global(.hljs-function),
	.agent-code :global(.hljs-title.class_),
	.agent-code :global(.hljs-title.function_) {
		color: #3979bd;
	}

	:global(.dark) .agent-code :global(.hljs-keyword),
	:global(.dark) .agent-code :global(.hljs-selector-tag),
	:global(.dark) .agent-code :global(.hljs-literal),
	:global(.dark) .agent-code :global(.hljs-deletion) {
		color: #ff7b8b;
	}

	:global(.dark) .agent-code :global(.hljs-string),
	:global(.dark) .agent-code :global(.hljs-title),
	:global(.dark) .agent-code :global(.hljs-section),
	:global(.dark) .agent-code :global(.hljs-built_in),
	:global(.dark) .agent-code :global(.hljs-addition) {
		color: #7ee2ad;
	}

	:global(.dark) .agent-code :global(.hljs-number),
	:global(.dark) .agent-code :global(.hljs-symbol),
	:global(.dark) .agent-code :global(.hljs-bullet) {
		color: #e7a66d;
	}

	:global(.dark) .agent-code :global(.hljs-attribute),
	:global(.dark) .agent-code :global(.hljs-name),
	:global(.dark) .agent-code :global(.hljs-selector-class) {
		color: #c6a6ff;
	}

	:global(.dark) .agent-code :global(.hljs-type),
	:global(.dark) .agent-code :global(.hljs-function),
	:global(.dark) .agent-code :global(.hljs-title.class_),
	:global(.dark) .agent-code :global(.hljs-title.function_) {
		color: #79b8ff;
	}
</style>
