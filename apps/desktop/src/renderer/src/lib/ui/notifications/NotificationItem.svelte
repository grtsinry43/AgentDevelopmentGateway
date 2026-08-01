<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';
	import type { AppNotification } from '$lib/shared/notifications/notifications.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		item: AppNotification;
		expanded: boolean;
		ontoggle: () => void;
		onclose?: () => void;
	}

	let { item, expanded, ontoggle, onclose }: Props = $props();

	const severityClass = $derived(
		item.severity === 'error'
			? 'bg-status-error'
			: item.severity === 'warning'
				? 'bg-status-waiting'
				: 'bg-accent'
	);
</script>

<article class="relative border-b border-subtle px-3 py-2.5 last:border-b-0">
	<div class="flex min-w-0 items-start gap-2">
		<span class={cx('mt-1.5 size-1.5 shrink-0 rounded-full', severityClass)}></span>
		<button type="button" class="min-w-0 flex-1 text-left" onclick={ontoggle}>
			<div class="flex min-w-0 items-center gap-1.5">
				<span class="min-w-0 flex-1 truncate text-xs font-medium text-strong">{item.title}</span>
				<Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} class="text-faint" />
			</div>
			<p class={cx('mt-0.5 text-xs text-muted', !expanded && 'truncate')}>{item.summary}</p>
		</button>
		{#if onclose}
			<button
				type="button"
				class="mt-0.5 shrink-0 text-faint hover:text-normal"
				aria-label="关闭通知"
				onclick={onclose}
			>
				<Icon name="close" size={11} />
			</button>
		{/if}
	</div>
	{#if expanded && item.detail}
		<pre
			class="scroll-thin mt-2 max-h-48 overflow-auto rounded-default bg-surface-base px-2 py-1.5 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap text-muted">{item.detail}</pre>
	{/if}
</article>
