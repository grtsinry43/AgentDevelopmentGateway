<script lang="ts">
	const PHRASES = [
		'working',
		'vibing',
		'deep seeking',
		'connecting dots',
		'cooking',
		'untangling',
		'spelunking',
		'pondering',
		'distilling',
		'threading thoughts',
		'polishing'
	] as const;

	function phraseAt(index: number): (typeof PHRASES)[number] {
		return PHRASES[index] ?? PHRASES[0];
	}

	let phrase = $state(phraseAt(Math.floor(Math.random() * PHRASES.length)));

	$effect(() => {
		const timer = window.setInterval(() => {
			const currentIndex = PHRASES.indexOf(phrase);
			const offset = 1 + Math.floor(Math.random() * (PHRASES.length - 1));
			phrase = phraseAt((currentIndex + offset) % PHRASES.length);
		}, 2800);

		return () => window.clearInterval(timer);
	});
</script>

<div class="flex h-9 items-center gap-2 py-2 text-xs" aria-label="Agent 正在工作">
	<span class="text-accent" aria-hidden="true">✦</span>
	{#key phrase}
		<span class="working-word font-medium tracking-wide" aria-hidden="true">{phrase}</span>
	{/key}
	<span class="text-accent" aria-hidden="true">…</span>
</div>

<style>
	.working-word {
		color: var(--text-accent);
		background-image: linear-gradient(
			105deg,
			color-mix(in srgb, var(--text-accent) 55%, transparent) 15%,
			var(--text-accent) 36%,
			var(--color-jade-300) 50%,
			var(--text-accent) 64%,
			color-mix(in srgb, var(--text-accent) 55%, transparent) 85%
		);
		background-size: 240% 100%;
		background-position: 120% 0;
		background-clip: text;
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: working-shimmer 1.9s ease-in-out infinite;
	}

	@keyframes working-shimmer {
		to {
			background-position: -120% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.working-word {
			background: none;
			-webkit-text-fill-color: currentColor;
			animation: none;
		}
	}
</style>
