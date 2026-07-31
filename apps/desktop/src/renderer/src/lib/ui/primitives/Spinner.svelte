<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		size?: 'sm' | 'md';
		class?: string;
		label?: string;
	}

	let { size = 'sm', class: className, label = '加载中' }: Props = $props();

	const sizes = { sm: 'h-3 w-3 border-[1.5px]', md: 'h-4 w-4 border-2' } as const;
</script>

<span
	role="status"
	aria-label={label}
	class={cx(
		'inline-block animate-spin rounded-full border-current border-t-transparent',
		sizes[size],
		className
	)}
></span>
