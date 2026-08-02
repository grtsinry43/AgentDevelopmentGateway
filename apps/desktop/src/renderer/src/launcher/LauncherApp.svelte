<script lang="ts">
	/**
	 * Launcher 窗口根组件。
	 *
	 * 只做编排:挂主题同步、挂唯一的 keydown 派发、组装标题 / 搜索 / 网格 / 提示条。
	 * 业务逻辑全在 `features/project`(AGENTS.md:窗口根组件只编排)。
	 */
	import { startThemeSync, theme } from '$lib/shared/theme/theme.svelte';
	import { keymap } from '$lib/shared/keymap/keymap.svelte';
	import { launcher } from '$lib/features/project/launcher.svelte';
	import { hostsStore } from '$lib/features/project/hosts.svelte';
	import RecentProjectGrid from '$lib/features/project/components/RecentProjectGrid.svelte';
	import RemoteHostsSection from '$lib/features/remote/components/RemoteHostsSection.svelte';
	import LauncherEntryList from '$lib/features/launcher/components/LauncherEntryList.svelte';
	import { stopServer as apiStopServer } from '$lib/features/remote/api';
	import { removeHost } from '$lib/features/project/api';
	import Button from '$lib/ui/primitives/Button.svelte';
	import ContextMenu, { type ContextMenuItem } from '$lib/ui/primitives/ContextMenu.svelte';
	import Dialog from '$lib/ui/primitives/Dialog.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import DitheredGrid from '$lib/ui/common/DitheredGrid.svelte';
	import PerspectiveFloor from '$lib/ui/common/PerspectiveFloor.svelte';
	import KeyHintBar from '$lib/ui/common/KeyHintBar.svelte';
	import OpeningProjectOverlay from '$lib/ui/common/OpeningProjectOverlay.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { desktop, systemInfo } from '$lib/shared/bridge/desktop';

	startThemeSync();

	/** 操作失败弹窗:launcher.actionError 置位即打开。 */
	let launcherActionErrorOpen = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);

	// 首屏数据:异步拉取,不阻塞渲染 —— UI 先出壳,数据到了再填。
	void launcher.load();
	void hostsStore.load().then(() => void hostsStore.probeAll());

	// 订阅主进程的列表变更推送。任何窗口改了工程列表这里都会跟上,不轮询。
	$effect(() => launcher.watch());
	$effect(() => hostsStore.watch());

	// 操作失败弹窗:actionError 置位即打开,关闭即清除。
	$effect(() => {
		if (launcher.actionError) launcherActionErrorOpen = true;
	});
	$effect(() => {
		if (!launcherActionErrorOpen && launcher.actionError) launcher.dismissActionError();
	});

	/** 右键菜单项按上下文动态计算。 */
	const contextItems = $derived.by<ContextMenuItem[]>(() => {
		const context = launcher.context;
		if (!context) return [];
		if (context.kind === 'project') {
			return [
				{
					label: '打开',
					icon: 'folder',
					run: () => void launcher.openProject(context.project.key)
				},
				{
					label: context.project.pinned ? '取消置顶' : '置顶',
					icon: 'pin',
					run: () => void launcher.togglePinProject(context.project.key)
				},
				{
					label: '删除',
					icon: 'close',
					danger: true,
					run: () => void launcher.removeProject(context.project.key)
				}
			];
		}
		if (context.kind === 'remote-project') {
			return [
				{
					label: '打开',
					icon: 'folder',
					run: () => void launcher.openProject(context.project.key)
				},
				{
					label: '删除',
					icon: 'close',
					danger: true,
					run: () => void launcher.removeProject(context.project.key)
				}
			];
		}
		return [
			{
				label: '管理主机…',
				icon: 'server',
				run: () => void desktop.window.openHostManager(context.host.id)
			},
			{ label: '刷新状态', icon: 'search', run: () => void hostsStore.probeAll() },
			{
				label: '停止 Server',
				icon: 'close',
				danger: true,
				run: () => void apiStopServer(context.host.id).then(() => hostsStore.probeAll())
			},
			{
				label: '删除主机',
				icon: 'close',
				danger: true,
				run: () => void removeHost(context.host.id)
			}
		];
	});

	function openNewProject(hostType: 'local' | 'ssh'): void {
		void desktop.window.openNewProject(hostType);
	}

	// Launcher 的键位作用域。⏎/⌫/j/k 这些单键在搜索框聚焦时由 keymap 自动让位给打字
	// (见 keymap.dispatch 的 isTextEntry 判断),所以搜索和导航可以共存。
	$effect(() =>
		keymap.pushScope('launcher', [
			{ keys: 'enter', label: '打开', run: () => void launcher.openSelected() },
			{ keys: 'mod+n', label: '本地工程', run: () => openNewProject('local') },
			{ keys: 'mod+shift+n', label: '远程工程', run: () => openNewProject('ssh') },
			{
				keys: 'mod+f',
				label: '搜索',
				run: () => {
					searchInput?.focus();
					searchInput?.select();
				}
			},
			{ keys: 'backspace', label: '移除', run: () => void launcher.removeSelected() },
			{ keys: 'mod+d', label: '置顶', run: () => void launcher.togglePinSelected() },
			// 最近工程是单列列表,方向键与 vim 键都按一项移动。
			{ keys: 'down', label: '', run: () => launcher.moveCursor(1) },
			{ keys: 'up', label: '', run: () => launcher.moveCursor(-1) },
			{ keys: 'right', label: '', run: () => launcher.moveCursor(1) },
			{ keys: 'left', label: '', run: () => launcher.moveCursor(-1) },
			{ keys: 'j', label: '', run: () => launcher.moveCursor(1) },
			{ keys: 'k', label: '', run: () => launcher.moveCursor(-1) },
			{ keys: 'l', label: '', run: () => launcher.moveCursor(1) },
			{ keys: 'h', label: '', run: () => launcher.moveCursor(-1) },
			{
				keys: 'escape',
				label: '',
				run: () => {
					// Esc 的语义按上下文降级:先清搜索,再失焦
					if (launcher.query) launcher.setQuery('');
					else searchInput?.blur();
				}
			}
		])
	);
</script>

<!-- 全应用唯一的 keydown 监听。业务组件一律通过 keymap.pushScope 注册。 -->
<svelte:window onkeydown={(event) => keymap.dispatch(event)} />

<div class="relative flex h-full flex-col overflow-hidden">
	<!--
		装饰分层:
		- 右上:稀疏矩形雨(不抢标题阅读)
		- 右下:透视地平面(角落 HUD)
		都在负空间,-z-10 + mask 收边。
	-->
	<div
		class="launcher-rain-mask pointer-events-none absolute top-0 right-0 left-1/2 -z-10 h-1/2 opacity-50"
	>
		<DitheredGrid density={0.72} cellSize={12} trailMin={12} trailMax={20} fadeBottom={false} />
	</div>
	<div
		class="launcher-floor-mask pointer-events-none absolute top-1/2 right-0 bottom-0 left-1/2 -z-10 opacity-40"
	>
		<PerspectiveFloor />
	</div>

	<!-- 顶部拖拽区:frameless 窗口需要一块可拖动的区域。macOS 的红绿灯就在这里。 -->
	<header class="drag-region shrink-0 px-7 pt-16 pb-6">
		<div class="flex items-end justify-between gap-4">
			<div class="no-drag">
				<h1 class="text-display leading-none font-medium tracking-[-0.025em] text-strong">
					Agent Development Gateway
				</h1>
				<p class="mt-2 text-xs tracking-wide text-faint">
					连接开发者、IDE、开发主机与多种 Coding Agent Runtime
				</p>
			</div>

			<div class="no-drag flex shrink-0 items-center gap-1">
				<Button variant="icon" title="设置" onclick={() => void desktop.window.openSettings()}>
					{#snippet icon()}
						<Icon name="settings" />
					{/snippet}
				</Button>
				<Button variant="icon" title={`主题:${theme.preference}`} onclick={() => theme.toggle()}>
					{#snippet icon()}
						<Icon name={theme.resolved === 'dark' ? 'moon' : 'sun'} />
					{/snippet}
				</Button>
			</div>
		</div>
	</header>

	<main class="flex min-h-0 flex-1 gap-8 px-7 pb-4">
		<section class="flex min-h-0 min-w-0 flex-1 flex-col gap-5" aria-label="工程与远程">
			<section class="flex min-h-0 flex-1 flex-col" aria-labelledby="recent-projects-heading">
				<div class="flex shrink-0 items-center gap-2 pb-2">
					<h2
						id="recent-projects-heading"
						class="mr-auto text-xs font-medium tracking-wide text-muted"
					>
						最近工程
					</h2>

					<Input
						bind:element={searchInput}
						value={launcher.query}
						type="search"
						placeholder="过滤名称或路径"
						class="w-44"
						oninput={(event) => launcher.setQuery((event.currentTarget as HTMLInputElement).value)}
					>
						{#snippet icon()}
							<Icon name="search" size={12} />
						{/snippet}
					</Input>

					<Button variant="primary" onclick={() => openNewProject('local')}>
						{#snippet icon()}
							<Icon name="plus" size={12} />
						{/snippet}
						新建
					</Button>
				</div>

				<div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
					<RecentProjectGrid />
				</div>
			</section>

			<section class="flex min-h-0 flex-[0.9] flex-col" aria-labelledby="remote-projects-heading">
				<div class="flex shrink-0 items-center gap-2 pb-2">
					<h2
						id="remote-projects-heading"
						class="mr-auto text-xs font-medium tracking-wide text-muted"
					>
						远程开发
					</h2>
					<Button variant="secondary" size="sm" onclick={() => openNewProject('ssh')}>
						{#snippet icon()}
							<Icon name="plus" size={11} />
						{/snippet}
						新建远程
					</Button>
				</div>

				<div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
					<RemoteHostsSection />
				</div>
			</section>
		</section>

		<aside
			class="w-64 min-w-0 shrink-0 border-l border-subtle pl-6"
			aria-labelledby="workspace-heading"
		>
			<div class="mb-3 flex h-7 items-center">
				<h2 id="workspace-heading" class="text-xs font-medium tracking-wide text-muted">工作台</h2>
			</div>
			<LauncherEntryList />
		</aside>
	</main>

	<KeyHintBar />
</div>

<!-- 打开远程项目耗时:显示「正在打开项目」提示层。 -->
<OpeningProjectOverlay
	visible={launcher.openingProject !== undefined}
	name={launcher.openingProject}
/>

<!-- 操作失败(如远程连接失败)弹窗展示,不占最近工程列表区。 -->
<Dialog
	bind:open={launcherActionErrorOpen}
	title="操作失败"
	description="打开或管理工程/主机时出错。"
>
	<p
		class="max-h-56 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-cinnabar-600 dark:text-cinnabar-400"
	>
		{launcher.actionError}
	</p>
	{#snippet footer()}
		<Button variant="primary" onclick={() => launcher.dismissActionError()}>关闭</Button>
	{/snippet}
</Dialog>

{#if launcher.context}
	<ContextMenu
		x={launcher.context.x}
		y={launcher.context.y}
		items={contextItems}
		onclose={() => launcher.closeContextMenu()}
	/>
{/if}

<!-- 非 macOS 平台没有原生 vibrancy,窗口底色必须不透明以免露出桌面 -->
{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}

<style>
	.launcher-rain-mask {
		mask-image: radial-gradient(
			120% 115% at 100% 0%,
			black 10%,
			rgba(0, 0, 0, 0.45) 48%,
			transparent 82%
		);
	}

	.launcher-floor-mask {
		mask-image: radial-gradient(
			115% 110% at 100% 100%,
			black 8%,
			rgba(0, 0, 0, 0.5) 42%,
			transparent 82%
		);
	}
</style>
