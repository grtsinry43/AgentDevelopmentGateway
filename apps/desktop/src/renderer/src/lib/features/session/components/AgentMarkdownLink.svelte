<script lang="ts">
	import type { Snippet } from 'svelte';
	import { openExternalUrl } from '$lib/shared/system/open-external';

	interface Props {
		href?: string;
		title?: string;
		children?: Snippet;
	}

	let { href = '', title, children }: Props = $props();

	const externalUrl = $derived.by(() => {
		try {
			const url = new URL(href);
			return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
		} catch {
			return undefined;
		}
	});

	function handleClick(event: MouseEvent): void {
		event.preventDefault();
		if (!externalUrl) return;
		void openExternalUrl(externalUrl);
	}
</script>

<a
	href={externalUrl}
	{title}
	class="font-medium text-accent underline decoration-jade-500/35 underline-offset-2 transition-colors hover:decoration-current"
	rel="noopener noreferrer"
	onclick={handleClick}
>
	{@render children?.()}
</a>
