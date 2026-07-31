<script lang="ts">
	/**
	 * Dialog 包装层。焦点陷阱、滚动锁、Esc 关闭、aria 关系全交给 bits-ui,
	 * 这里只统一视觉与「弹窗打开时压一个 modal keymap scope」的行为。
	 *
	 * 需求 §14.2 要求「最少弹窗」—— 这个组件应该只用在真正需要中断流程的地方
	 * (新建工程、危险确认),日常操作走命令面板或内联编辑。
	 */
	import { Dialog } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { keymap } from '$lib/shared/keymap/keymap.svelte';

	interface Props {
		open?: boolean;
		title: string;
		description?: string;
		/** 内容区最大宽度类。默认适合表单。 */
		width?: string;
		class?: string;
		children: Snippet;
		/** 底部操作区。 */
		footer?: Snippet;
	}

	let {
		open = $bindable(false),
		title,
		description,
		width = 'max-w-md',
		class: className,
		children,
		footer
	}: Props = $props();

	// 打开时压一个 modal scope:底层的单键导航(j/k/⏎)必须失效,
	// 否则用户会在看不见的列表上触发操作。Esc 由 bits-ui 自己处理。
	$effect(() => {
		if (!open) return;
		return keymap.pushScope('dialog', [], { modal: true });
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay
			class="fixed inset-0 z-50 bg-ink-950/35 backdrop-blur-[2px] dark:bg-ink-950/60"
		/>
		<Dialog.Content
			class={cx(
				'fixed top-1/2 left-1/2 z-50 w-[calc(100vw-4rem)] -translate-x-1/2 -translate-y-1/2',
				'rounded-card border border-line bg-surface-raised shadow-deep',
				width,
				className
			)}
		>
			<header class="border-b border-subtle px-4 py-3">
				<Dialog.Title class="text-base font-medium text-strong">{title}</Dialog.Title>
				{#if description}
					<Dialog.Description class="mt-0.5 text-xs text-muted">
						{description}
					</Dialog.Description>
				{/if}
			</header>

			<div class="px-4 py-3.5">
				{@render children()}
			</div>

			{#if footer}
				<footer class="flex items-center justify-end gap-2 border-t border-subtle px-4 py-2.5">
					{@render footer()}
				</footer>
			{/if}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
