<script lang="ts">
	/**
	 * 右键上下文菜单。悬浮于给定坐标,点击外部 / Esc / 选中项后关闭。
	 * 键盘:↑↓ 移动,Enter 执行,Esc 关闭。
	 */
	import { onMount } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import Icon, { type IconName } from '$lib/ui/icons/Icon.svelte';

	export interface ContextMenuItem {
		label: string;
		icon?: IconName;
		danger?: boolean;
		disabled?: boolean;
		run?: () => void;
	}

	interface Props {
		x: number;
		y: number;
		items: ContextMenuItem[];
		onclose: () => void;
	}

	let { x, y, items, onclose }: Props = $props();

	let menu: HTMLElement | undefined;
	let focused = $state(0);

	onMount(() => {
		if (!menu) return;
		// 菜单靠近窗口右/下边缘时翻转到可视范围内。
		const rect = menu.getBoundingClientRect();
		const pad = 8;
		if (rect.right > window.innerWidth - pad) x -= rect.right - (window.innerWidth - pad);
		if (rect.bottom > window.innerHeight - pad) y -= rect.bottom - (window.innerHeight - pad);
		menu.style.left = `${Math.max(pad, x)}px`;
		menu.style.top = `${Math.max(pad, y)}px`;
		menu.focus();
	});

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onclose();
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const delta = event.key === 'ArrowDown' ? 1 : -1;
			const count = items.length;
			focused = (focused + delta + count) % count;
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			const item = items[focused];
			if (item && !item.disabled) {
				item.run?.();
				onclose();
			}
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<button
	type="button"
	class="fixed inset-0 z-50 cursor-default bg-transparent"
	aria-label="关闭菜单"
	onclick={onclose}
></button>

<div
	class="fixed z-50 min-w-44 rounded-default border border-line bg-surface-raised p-1 shadow-lg"
	role="menu"
	bind:this={menu}
	tabindex="-1"
	style:left="{x}px"
	style:top="{y}px"
>
	{#each items as item, index (item.label)}
		<button
			type="button"
			role="menuitem"
			disabled={item.disabled}
			class={cx(
				'flex h-6.5 w-full items-center gap-2 rounded-[3px] px-2 text-left text-xs transition-colors',
				index === focused ? 'bg-surface-active text-strong' : 'text-muted',
				item.danger ? 'text-cinnabar-600 dark:text-cinnabar-400' : '',
				'disabled:pointer-events-none disabled:opacity-40'
			)}
			onmouseenter={() => (focused = index)}
			onclick={() => {
				if (item.disabled) return;
				item.run?.();
				onclose();
			}}
		>
			{#if item.icon}
				<Icon name={item.icon} size={11} class="shrink-0" />
			{/if}
			<span class="truncate">{item.label}</span>
		</button>
	{/each}
</div>
