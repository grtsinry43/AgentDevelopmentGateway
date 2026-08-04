<script lang="ts">
	import type { Snippet } from 'svelte';
	import { filePreview } from '$lib/features/files/file-preview.svelte';
	import { parseAgentGatewayFileHref } from '$lib/features/files/agent-gateway-uri';
	import { openExternalUrl } from '$lib/shared/system/open-external';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		href?: string;
		title?: string;
		children?: Snippet;
	}

	let { href = '', title, children }: Props = $props();

	const gatewayRef = $derived(parseAgentGatewayFileHref(href));

	const externalUrl = $derived.by(() => {
		if (gatewayRef) return undefined;
		try {
			const url = new URL(href);
			return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
		} catch {
			return undefined;
		}
	});

	function handleClick(event: MouseEvent): void {
		event.preventDefault();
		if (gatewayRef) {
			void filePreview.open(gatewayRef.path, {
				line: gatewayRef.line,
				startLine: gatewayRef.startLine,
				endLine: gatewayRef.endLine
			});
			return;
		}
		if (!externalUrl) return;
		void openExternalUrl(externalUrl);
	}
</script>

{#if gatewayRef}
	<button
		type="button"
		class="inline-flex max-w-full items-center gap-1 rounded-default bg-jade-500/12 px-1.5 py-px align-baseline text-accent hover:bg-jade-500/18"
		{title}
		onclick={handleClick}
	>
		<Icon name="file-text" size={12} class="shrink-0" />
		<span class="min-w-0 truncate font-semibold">
			{#if children}{@render children()}{/if}
		</span>
	</button>
{:else}
	<a
		href={externalUrl}
		{title}
		class="font-medium text-accent underline decoration-jade-500/35 underline-offset-2 transition-colors hover:decoration-current"
		rel="noopener noreferrer"
		onclick={handleClick}
	>
		{#if children}{@render children()}{/if}
	</a>
{/if}
