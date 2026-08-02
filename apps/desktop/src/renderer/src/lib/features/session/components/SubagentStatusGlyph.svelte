<script lang="ts">
	import type { SubagentRun } from '@agent-gateway/core';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		status: SubagentRun['status'];
	}

	let { status }: Props = $props();

	const mode = $derived.by(() => {
		if (status === 'completed') return 'completed' as const;
		if (status === 'failed') return 'failed' as const;
		if (status === 'interrupted' || status === 'cancelled') return 'muted-fail' as const;
		return 'thinking' as const;
	});
</script>

<span
	class="relative grid h-7 w-7 shrink-0 place-items-center rounded-default bg-surface-overlay"
	aria-hidden="true"
>
	{#if mode === 'thinking'}
		<span class="thinking">
			{#each [0, 1, 2] as col (col)}
				<span class="thinking-col" style="--col: {col}">
					{#each [0, 1, 2] as row (row)}
						<span class="thinking-dot" style="--i: {col * 3 + row}"></span>
					{/each}
				</span>
			{/each}
		</span>
	{:else if mode === 'completed'}
		<span class="text-status-completed">
			<Icon name="check" size={14} />
		</span>
	{:else if mode === 'failed'}
		<span class="text-status-error">
			<Icon name="close" size={12} />
		</span>
	{:else}
		<span class="text-muted">
			<Icon name="close" size={12} />
		</span>
	{/if}
</span>

<style>
	.thinking {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 14px;
	}

	.thinking-col {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		animation: thinking-bob calc(0.85s + var(--col) * 0.28s) ease-in-out infinite alternate;
		animation-delay: calc(var(--col) * -0.37s);
	}

	.thinking-dot {
		display: block;
		width: 2.5px;
		height: 2.5px;
		border-radius: 999px;
		background: var(--text-strong);
		animation: thinking-flicker calc(1.05s + var(--i) * 0.14s) ease-in-out infinite;
		animation-delay: calc(var(--i) * -0.19s);
	}

	@keyframes thinking-bob {
		from {
			transform: translateY(-2.5px);
		}
		to {
			transform: translateY(2.5px);
		}
	}

	@keyframes thinking-flicker {
		0%,
		100% {
			opacity: 0.28;
		}
		40% {
			opacity: 1;
		}
		70% {
			opacity: 0.55;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.thinking-col,
		.thinking-dot {
			animation: none;
		}

		.thinking-dot {
			opacity: 0.75;
		}
	}
</style>
