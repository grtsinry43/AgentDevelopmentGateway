<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { formatKeys } from '$lib/shared/keymap/keymap.svelte';

	interface Props {
		/** 归一化组合键,如 `mod+k`。会被平台化渲染成 ⌘K / Ctrl+K。 */
		keys?: string;
		/** 直接给字面文本(不做平台化),用于 `↑↓` 这类已经是符号的提示。 */
		children?: Snippet;
		class?: string;
	}

	let { keys, children, class: className }: Props = $props();

	const label = $derived(keys ? formatKeys(keys) : '');
</script>

<kbd
	class={cx(
		'inline-flex h-4 min-w-4 items-center justify-center rounded-[2px] px-1',
		'border border-subtle bg-surface-hover font-mono text-2xs text-faint',
		'align-middle leading-none',
		className
	)}
>
	{#if children}
		{@render children()}
	{:else}
		{label}
	{/if}
</kbd>
