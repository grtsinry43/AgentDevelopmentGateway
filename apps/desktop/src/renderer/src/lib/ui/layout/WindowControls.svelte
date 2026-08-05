<script lang="ts">
	/**
	 * 自绘窗口控制:最小化 / 最大化切换 / 关闭。
	 *
	 * macOS 有原生红绿灯,此组件在 macOS 上不渲染任何东西;其他平台所有
	 * frameless 窗口共用这一份实现,保证跨窗口行为与样式一致
	 * (AGENTS.md:契约只有一个来源)。
	 *
	 * 根节点带 no-drag:控件几乎总是放在 drag-region 里,必须可点击。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import { desktop, systemInfo } from '$lib/shared/bridge/desktop';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		/** 窗口是否允许最大化(如 Launcher/设置窗口不可最大化,则不画最大化按钮)。 */
		showMaximize?: boolean;
		class?: string;
	}

	let { showMaximize = true, class: className }: Props = $props();

	const isMac = systemInfo.platform === 'darwin';
</script>

{#if !isMac}
	<div class={cx('no-drag flex items-center gap-1', className)}>
		<Button
			variant="icon"
			size="sm"
			title="最小化"
			onclick={() => void desktop.window.minimize()}
		>
			{#snippet icon()}
				<span class="block h-px w-2.5 bg-current"></span>
			{/snippet}
		</Button>
		{#if showMaximize}
			<Button
				variant="icon"
				size="sm"
				title="最大化"
				onclick={() => void desktop.window.toggleMaximize()}
			>
				{#snippet icon()}
					<span class="block h-2 w-2 border border-current"></span>
				{/snippet}
			</Button>
		{/if}
		<Button variant="icon" size="sm" title="关闭" onclick={() => void desktop.window.close()}>
			{#snippet icon()}
				<Icon name="close" size={11} />
			{/snippet}
		</Button>
	</div>
{/if}
