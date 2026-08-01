<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { notifications } from '$lib/shared/notifications/notifications.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import NotificationItem from './NotificationItem.svelte';

	const expandedIds = new SvelteSet<string>();

	function toggleExpanded(id: string): void {
		if (expandedIds.has(id)) expandedIds.delete(id);
		else expandedIds.add(id);
	}
</script>

{#if notifications.toast && !notifications.open}
	<div
		class="notification-enter fixed right-2 bottom-9 z-50 w-[min(24rem,calc(100vw-1rem))] overflow-hidden rounded-panel border border-line bg-surface-overlay shadow-subtle backdrop-blur-xl"
	>
		<NotificationItem
			item={notifications.toast}
			expanded={expandedIds.has(notifications.toast.id)}
			ontoggle={() => toggleExpanded(notifications.toast?.id ?? '')}
			onclose={() => notifications.dismissToast()}
		/>
	</div>
{/if}

{#if notifications.open}
	<section
		class="fixed right-2 bottom-9 z-50 flex max-h-[min(32rem,70vh)] w-[min(26rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-panel border border-line bg-surface-overlay shadow-subtle backdrop-blur-xl"
		aria-label="通知中心"
	>
		<header class="flex h-8 shrink-0 items-center border-b border-subtle px-3">
			<span class="text-xs font-medium text-strong">通知</span>
			<span class="ml-1.5 font-mono text-2xs text-faint">{notifications.items.length}</span>
			{#if notifications.items.length > 0}
				<button
					type="button"
					class="ml-auto text-2xs text-faint hover:text-normal"
					onclick={() => notifications.clear()}
				>
					清空
				</button>
			{/if}
		</header>
		<div class="scroll-thin min-h-0 overflow-y-auto">
			{#if notifications.items.length === 0}
				<p class="px-3 py-8 text-center text-xs text-faint">暂无通知</p>
			{:else}
				{#each notifications.items as item (item.id)}
					<NotificationItem
						{item}
						expanded={expandedIds.has(item.id)}
						ontoggle={() => toggleExpanded(item.id)}
					/>
				{/each}
			{/if}
		</div>
	</section>
{/if}

<button
	type="button"
	class="relative flex size-6 shrink-0 items-center justify-center text-faint hover:bg-surface-hover hover:text-normal"
	class:bg-surface-active={notifications.open}
	class:text-normal={notifications.open}
	aria-label="通知中心"
	aria-expanded={notifications.open}
	onclick={() => notifications.toggle()}
>
	<Icon name="bell" size={12} />
	{#if notifications.unreadCount > 0}
		<span class="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-status-error"></span>
	{/if}
</button>

<style>
	.notification-enter {
		animation: notification-enter 160ms ease-out;
	}

	@keyframes notification-enter {
		from {
			opacity: 0;
			transform: translateX(12px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
