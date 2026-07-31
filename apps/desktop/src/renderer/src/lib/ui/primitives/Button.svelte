<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';

	type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
	type Size = 'sm' | 'md';

	interface Props {
		variant?: Variant;
		size?: Size;
		/** 加载中:禁用交互并显示 spinner。 */
		loading?: boolean;
		disabled?: boolean;
		fullWidth?: boolean;
		type?: 'button' | 'submit' | 'reset';
		/** 无障碍标签。icon 变体必须提供。 */
		title?: string;
		class?: string;
		icon?: Snippet;
		children?: Snippet;
		onclick?: (event: MouseEvent) => void;
	}

	let {
		variant = 'secondary',
		size = 'md',
		loading = false,
		disabled = false,
		fullWidth = false,
		type = 'button',
		title,
		class: className,
		icon,
		children,
		onclick
	}: Props = $props();

	const base =
		'inline-flex items-center justify-center gap-1.5 rounded-default font-normal ' +
		'transition-colors duration-150 select-none ' +
		'disabled:pointer-events-none disabled:opacity-45';

	const sizes = {
		sm: 'h-6 px-2 text-xs',
		md: 'h-7 px-2.5 text-sm'
	} as const;

	const variants = {
		primary: 'bg-jade-700 text-white hover:bg-jade-600 dark:bg-jade-600 dark:hover:bg-jade-500',
		secondary:
			'border border-line bg-surface-raised text-strong hover:bg-surface-hover shadow-subtle',
		ghost: 'text-muted hover:bg-surface-hover hover:text-strong',
		danger:
			'border border-cinnabar-300 text-cinnabar-700 hover:bg-cinnabar-50 ' +
			'dark:border-cinnabar-800 dark:text-cinnabar-300 dark:hover:bg-cinnabar-950/40',
		icon: 'text-muted hover:bg-surface-hover hover:text-strong'
	} as const;

	// icon 变体是正方形,不吃水平 padding
	const iconSizes = { sm: 'h-6 w-6 p-0', md: 'h-7 w-7 p-0' } as const;

	const isDisabled = $derived(disabled || loading);
	const classes = $derived(
		cx(
			base,
			variant === 'icon' ? iconSizes[size] : sizes[size],
			variants[variant],
			fullWidth && 'w-full',
			className
		)
	);
</script>

<button {type} {title} class={classes} disabled={isDisabled} aria-busy={loading} {onclick}>
	{#if loading}
		<span
			class="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
			aria-hidden="true"
		></span>
	{:else if icon}
		{@render icon()}
	{/if}
	{#if children}
		{@render children()}
	{/if}
</button>
