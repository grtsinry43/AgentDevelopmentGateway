<script lang="ts">
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		checked: boolean;
		disabled?: boolean;
		/** 右侧文字(可选)。 */
		label?: string;
		title?: string;
		onchange?: (checked: boolean) => void;
	}

	let { checked, disabled = false, label, title, onchange }: Props = $props();

	function toggle(): void {
		if (disabled) return;
		onchange?.(!checked);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		toggle();
	}
</script>

<label
	class="flex cursor-pointer items-center gap-2 text-2xs text-muted select-none"
	class:pointer-events-none={disabled}
	class:opacity-50={disabled}
	{title}
>
	<span
		role="checkbox"
		tabindex={disabled ? -1 : 0}
		aria-checked={checked}
		class={cx(
			'grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
			'focus-visible:border-line-accent focus-visible:outline-none',
			checked
				? 'border-line-accent bg-surface-selected text-accent'
				: 'border-line bg-surface-raised text-transparent'
		)}
		onclick={(event) => {
			event.preventDefault();
			toggle();
		}}
		onkeydown={onKeydown}
	>
		<Icon name="check" size={10} />
	</span>
	{#if label}
		<span>{label}</span>
	{/if}
</label>
