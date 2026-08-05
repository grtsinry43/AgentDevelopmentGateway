<script lang="ts">
	/**
	 * 应用菜单触发按钮(左上角,Linux 专用)。
	 *
	 * macOS 有系统菜单栏;Linux frameless 窗口没有原生菜单栏,靠它调出应用菜单
	 * (文件/主机/编辑/视图/窗口,View 里含「切换开发者工具」)。Windows 暂不显示,
	 * 有原生快捷键可开 DevTools。
	 *
	 * 与 WindowControls 一样:根节点带 no-drag,放在 drag-region 里也能点击;
	 * 其他平台它不渲染任何东西。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import { desktop, systemInfo } from '$lib/shared/bridge/desktop';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		class?: string;
	}

	let { class: className }: Props = $props();

	const isLinux = systemInfo.platform === 'linux';
</script>

{#if isLinux}
	<Button
		variant="icon"
		size="sm"
		title="应用菜单 (View → 切换开发者工具)"
		class={cx('no-drag', className)}
		onclick={() => void desktop.window.popupMenu()}
	>
		{#snippet icon()}
			<Icon name="menu" size={13} />
		{/snippet}
	</Button>
{/if}
