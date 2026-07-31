<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		orientation?: 'horizontal' | 'vertical';
		class?: string;
	}

	let { orientation = 'horizontal', class: className }: Props = $props();
</script>

<div
	role="separator"
	aria-orientation={orientation}
	class={cx(
		'shrink-0 bg-subtle',
		orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
		className
	)}
></div>
