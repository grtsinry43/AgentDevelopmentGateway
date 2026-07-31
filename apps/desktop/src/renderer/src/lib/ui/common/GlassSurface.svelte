<script lang="ts">
	/**
	 * 毛玻璃容器。
	 *
	 * 跨平台差异集中在这里(计划风险条目 2):macOS 有原生 vibrancy,窗口底色是透明的,
	 * 半透明底 + blur 能透出桌面;Windows/Linux 上窗口底色不透明,这里的半透明只是
	 * 透出应用自身的背景层 —— 观感稍弱但不会露出桌面。
	 */
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		/** raised 用于卡片,flush 用于大面积面板(blur 更弱以免过度模糊)。 */
		variant?: 'raised' | 'flush';
		interactive?: boolean;
		selected?: boolean;
		class?: string;
		children: Snippet;
	}

	let {
		variant = 'raised',
		interactive = false,
		selected = false,
		class: className,
		children
	}: Props = $props();

	const variants = {
		raised:
			'rounded-card border border-white/60 bg-white/55 shadow-glass backdrop-blur-[20px] ' +
			'dark:border-white/8 dark:bg-ink-900/50 dark:shadow-glass-dark',
		flush:
			'rounded-panel border border-white/40 bg-white/35 backdrop-blur-[12px] ' +
			'dark:border-white/6 dark:bg-ink-900/35'
	} as const;
</script>

<div
	class={cx(
		'relative overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]',
		variants[variant],
		interactive && 'hover:-translate-y-px hover:border-jade-300/60 hover:shadow-float',
		interactive && 'dark:hover:border-jade-700/40',
		selected && 'border-jade-400/70 ring-1 ring-jade-400/40 dark:border-jade-500/60',
		className
	)}
>
	{@render children()}
</div>
