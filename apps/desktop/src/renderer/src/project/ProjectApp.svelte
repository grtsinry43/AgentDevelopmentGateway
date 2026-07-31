<script lang="ts">
	/**
	 * Project 窗口根组件。
	 *
	 * 只做编排:挂主题同步、挂唯一的 keydown 派发、组装三栏 + 状态栏。
	 * 业务逻辑在 `features/workspace`,渲染逻辑在 `ui/layout`。
	 */
	import { startThemeSync, theme } from '$lib/shared/theme/theme.svelte';
	import { keymap } from '$lib/shared/keymap/keymap.svelte';
	import { requireProjectKey, systemInfo } from '$lib/shared/bridge/desktop';
	import { availablePanels } from '$lib/shared/registry/panels';
	import { tildify } from '$lib/shared/utils/path';
	import { LEFT_TABS, layout } from '$lib/features/workspace/layout.svelte';
	import { registerWorkspacePanels } from '$lib/features/workspace/panels';
	import LeftSidebar from '$lib/features/workspace/components/LeftSidebar.svelte';
	import DockStack from '$lib/ui/layout/DockStack.svelte';
	import ResizeHandle from '$lib/ui/layout/ResizeHandle.svelte';
	import StatusBar from '$lib/ui/layout/StatusBar.svelte';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import KeyHintBar from '$lib/ui/common/KeyHintBar.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	startThemeSync();
	registerWorkspacePanels();

	const projectKey = requireProjectKey();
	// projectKey 形如 `hostId:path`。hostId 里不含冒号,所以第一个冒号就是分界。
	const separator = projectKey.indexOf(':');
	const hostId = projectKey.slice(0, separator);
	const projectPath = projectKey.slice(separator + 1);
	const displayPath = $derived(tildify(projectPath, systemInfo.homeDir));
	const projectName = $derived(displayPath.split(/[/\\]/).filter(Boolean).at(-1) ?? projectPath);

	// 布局:异步读回,读回前用默认值渲染 —— 不阻塞首帧
	void layout.load();

	/** 键盘聚焦的面板 id。⌘1..9 设置。 */
	let focusedPanelId = $state<string | undefined>(undefined);

	/**
	 * 当前会话的 runtime capabilities。
	 * 还没有会话层,先给 undefined —— availablePanels 会因此只返回无能力依赖的面板。
	 * 接上会话后这里换成真实的 `RuntimeCapabilities.features`,面板自动按能力出现。
	 */
	const capabilities = $derived(undefined);
	const addablePanels = $derived(availablePanels(capabilities));

	$effect(() =>
		keymap.pushScope('project', [
			{ keys: 'mod+b', label: '侧栏', run: () => layout.toggleLeft() },
			{ keys: 'mod+alt+b', label: '右侧面板', run: () => layout.toggleRight() },
			// ⌘⇧1..4 切左侧 tab
			...LEFT_TABS.map((tab, index) => ({
				keys: `mod+shift+${index + 1}`,
				label: '',
				run: () => layout.setLeftTab(tab)
			})),
			// ⌘1..9 聚焦第 N 个 dock 面板
			...Array.from({ length: 9 }, (_, index) => ({
				keys: `mod+${index + 1}`,
				label: '',
				run: () => {
					const panel = layout.panelAt(index);
					if (!panel) return;
					focusedPanelId = panel.id;
					layout.rightCollapsed = false;
				}
			}))
		])
	);
</script>

<!-- 全应用唯一的 keydown 监听。业务组件一律通过 keymap.pushScope 注册。 -->
<svelte:window onkeydown={(event) => keymap.dispatch(event)} />

<div class="flex h-full flex-col overflow-hidden">
	<TitleBar title={projectName} subtitle="{displayPath} @{hostId}">
		{#snippet actions()}
			<Button variant="icon" size="sm" title="切换侧栏 (⌘B)" onclick={() => layout.toggleLeft()}>
				{#snippet icon()}
					<Icon name="layers" size={12} />
				{/snippet}
			</Button>
			<Button
				variant="icon"
				size="sm"
				title={`主题:${theme.preference}`}
				onclick={() => theme.toggle()}
			>
				{#snippet icon()}
					<Icon name={theme.resolved === 'dark' ? 'moon' : 'sun'} size={12} />
				{/snippet}
			</Button>
		{/snippet}
	</TitleBar>

	<div class="flex min-h-0 flex-1">
		<!-- 左侧栏 -->
		{#if !layout.leftCollapsed}
			<aside
				class="flex min-h-0 shrink-0 flex-col bg-surface-panel"
				style:width="{layout.leftWidth}px"
			>
				<LeftSidebar />
			</aside>
			<ResizeHandle
				label="调整侧栏宽度"
				onDrag={(delta) =>
					layout.setLeftWidth(Math.min(480, Math.max(180, layout.leftWidth + delta)))}
			/>
		{/if}

		<!-- 中间主区:会话在下一阶段接入 -->
		<main class="flex min-h-0 min-w-0 flex-1 flex-col">
			<EmptyState
				title="会话区（下一阶段）"
				description="事件投影层与 Conversation / ToolCall / Permission 渲染将在这里接入。"
			>
				{#snippet icon()}
					<Icon name="message" size={22} />
				{/snippet}
			</EmptyState>
		</main>

		<!-- 右侧 dock -->
		{#if !layout.rightCollapsed}
			<ResizeHandle
				label="调整右侧面板宽度"
				onDrag={(delta) =>
					layout.setRightWidth(Math.min(640, Math.max(220, layout.rightWidth - delta)))}
			/>
			<aside
				class="flex min-h-0 shrink-0 flex-col bg-surface-panel"
				style:width="{layout.rightWidth}px"
			>
				<!-- dock 工具条:添加面板 -->
				<div class="flex h-6 shrink-0 items-center gap-1 border-b border-subtle px-2">
					<span class="mr-auto text-2xs tracking-wide text-faint uppercase">面板</span>
					{#each addablePanels as panel (panel.type)}
						<Button
							variant="icon"
							size="sm"
							title="添加{panel.title}"
							onclick={() => layout.addPanel(panel.type)}
						>
							{#snippet icon()}
								<Icon name={panel.icon} size={11} />
							{/snippet}
						</Button>
					{/each}
				</div>

				<DockStack focusedId={focusedPanelId} />
			</aside>
		{/if}
	</div>

	<StatusBar />
	<KeyHintBar />
</div>

<!-- 非 macOS 平台没有原生 vibrancy,窗口底色必须不透明以免露出桌面 -->
{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
