<script lang="ts">
	import { highlightCode, normalizeCodeLanguage } from '../markdown/highlight';
	import '../markdown/hljs-theme.css';
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
