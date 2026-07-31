<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		value?: string;
		placeholder?: string;
		type?: 'text' | 'search' | 'password';
		disabled?: boolean;
		invalid?: boolean;
		mono?: boolean;
		/** 左侧图标槽。 */
		icon?: Snippet;
		/** 右侧附属槽(计数、清除按钮、快捷键提示)。 */
		suffix?: Snippet;
		class?: string;
		oninput?: (event: Event) => void;
		onkeydown?: (event: KeyboardEvent) => void;
		/** 双向绑定用。父组件需要聚焦时通过这个引用调 focus()。 */
		element?: HTMLInputElement | null;
	}

	let {
		value = $bindable(''),
		placeholder,
		type = 'text',
		disabled = false,
		invalid = false,
		mono = false,
		icon,
		suffix,
		class: className,
		oninput,
		onkeydown,
		element = $bindable(null)
	}: Props = $props();
</script>

<div
	class={cx(
		'group relative flex h-7 items-center gap-1.5 rounded-default border px-2',
		'bg-surface-raised transition-colors duration-150',
		invalid ? 'border-cinnabar-400' : 'border-line focus-within:border-line-accent',
		disabled && 'pointer-events-none opacity-50',
		className
	)}
>
	{#if icon}
		<span class="flex shrink-0 text-faint">{@render icon()}</span>
	{/if}

	<input
		bind:this={element}
		bind:value
		{type}
		{placeholder}
		{disabled}
		spellcheck="false"
		autocomplete="off"
		aria-invalid={invalid || undefined}
		class={cx(
			'min-w-0 flex-1 bg-transparent text-sm text-strong outline-none',
			'placeholder:text-faint',
			mono && 'font-mono'
		)}
		{oninput}
		{onkeydown}
	/>

	{#if suffix}
		<span class="flex shrink-0 items-center gap-1">{@render suffix()}</span>
	{/if}
</div>
