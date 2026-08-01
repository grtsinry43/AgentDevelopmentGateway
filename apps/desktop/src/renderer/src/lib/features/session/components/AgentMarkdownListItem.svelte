<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SvmdElementNode } from 'svmarkdown';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		node?: SvmdElementNode;
		children?: Snippet;
		class?: string;
	}

	let { node, children, class: className = '' }: Props = $props();
	const task = $derived(node?.attrs['data-task'] === 'true');
	const checked = $derived(node?.attrs['data-checked'] === 'true');
</script>

{#if task}
	<li class={`flex list-none items-start gap-2 ${className}`.trim()}>
		<span
			class="border-default mt-[0.3rem] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border"
			class:border-line-accent={checked}
			class:bg-surface-selected={checked}
			role="checkbox"
			aria-checked={checked}
			aria-readonly="true"
		>
			{#if checked}<Icon name="check" size={10} class="text-accent" />{/if}
		</span>
		<span class:line-through={checked} class:text-faint={checked}>{@render children?.()}</span>
	</li>
{:else}
	<li class={className}>{@render children?.()}</li>
{/if}
