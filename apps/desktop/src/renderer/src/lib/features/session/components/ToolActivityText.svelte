<script lang="ts">
	interface Props {
		text: string;
		active?: boolean;
		class?: string;
	}

	let { text, active = false, class: className = '' }: Props = $props();
</script>

<span class={`${className} ${active ? 'tool-running-shimmer' : ''}`}>{text}</span>

<style>
	.tool-running-shimmer {
		color: transparent;
		background: linear-gradient(
			100deg,
			color-mix(in srgb, var(--text-accent) 48%, transparent) 12%,
			var(--text-accent) 38%,
			color-mix(in srgb, var(--text-accent) 58%, white) 50%,
			var(--text-accent) 62%,
			color-mix(in srgb, var(--text-accent) 48%, transparent) 88%
		);
		background-size: 220% 100%;
		background-clip: text;
		-webkit-background-clip: text;
		animation: tool-shimmer 1.8s linear infinite;
	}

	@keyframes tool-shimmer {
		from {
			background-position: 200% 0;
		}
		to {
			background-position: -20% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tool-running-shimmer {
			color: var(--text-accent);
			background: none;
			animation: none;
		}
	}
</style>
