<script lang="ts">
	interface Props {
		text: string;
		streaming: boolean;
		durationMs?: number;
	}

	let { text, streaming, durationMs }: Props = $props();

	const title = $derived.by(() => {
		if (streaming) return '思考中';
		if (durationMs === undefined) return '思考完成';
		if (durationMs < 100) return '思考了少于 0.1 秒';
		return `思考了 ${(durationMs / 1000).toFixed(1)} 秒`;
	});
</script>

<details
	class="reasoning-block content-auto selectable border-b border-subtle py-2"
	open={streaming}
>
	<summary
		class="flex cursor-pointer list-none items-center gap-2 text-xs text-muted select-none hover:text-normal"
	>
		<span class="reasoning-chevron text-faint" aria-hidden="true">›</span>
		<span>{title}</span>
		{#if streaming}
			<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-status-running"></span>
		{/if}
	</summary>
	<div
		class="mt-2 border-l border-subtle pl-3 font-mono text-xs leading-5 whitespace-pre-wrap text-muted"
	>
		{text || '…'}
	</div>
</details>

<style>
	.reasoning-block[open] .reasoning-chevron {
		transform: rotate(90deg);
	}

	.reasoning-chevron {
		display: inline-block;
		transition: transform 120ms ease;
	}

	.reasoning-block summary::-webkit-details-marker {
		display: none;
	}
</style>
