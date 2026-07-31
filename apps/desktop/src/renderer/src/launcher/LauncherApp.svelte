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
	import NewProjectDialog from '$lib/features/project/components/NewProjectDialog.svelte';
	import RecentProjectGrid from '$lib/features/project/components/RecentProjectGrid.svelte';
	import LauncherEntryList from '$lib/features/launcher/components/LauncherEntryList.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import DitheredGrid from '$lib/ui/common/DitheredGrid.svelte';
	import KeyHintBar from '$lib/ui/common/KeyHintBar.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { systemInfo } from '$lib/shared/bridge/desktop';

	startThemeSync();

	let dialogOpen = $state(false);
	let dialogHostType = $state<'local' | 'ssh'>('local');
	let searchInput = $state<HTMLInputElement | null>(null);

	// 首屏数据:异步拉取,不阻塞渲染 —— UI 先出壳,数据到了再填。
	void launcher.load();

	// 订阅主进程的列表变更推送。任何窗口改了工程列表这里都会跟上,不轮询。
	$effect(() => launcher.watch());

	function openDialog(hostType: 'local' | 'ssh'): void {
		dialogHostType = hostType;
		dialogOpen = true;
	}

	// Launcher 的键位作用域。⏎/⌫/j/k 这些单键在搜索框聚焦时由 keymap 自动让位给打字
	// (见 keymap.dispatch 的 isTextEntry 判断),所以搜索和导航可以共存。
	$effect(() =>
		keymap.pushScope('launcher', [
			{ keys: 'enter', label: '打开', run: () => void launcher.openSelected() },
			{ keys: 'mod+n', label: '本地工程', run: () => openDialog('local') },
			{ keys: 'mod+shift+n', label: '远程工程', run: () => openDialog('ssh') },
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
		装饰格阵:右下象限,宽高各约占窗口一半。
		放标题区背后会和文字抢注意力(格子的高频纹理干扰阅读),挪到右下做「角落纹理」——
		视觉重量落在空白处,也是阅读路径(左上→右下)的末端。
		不传 rows = 铺满这个容器的高度;mask 从右下角向左上衰减,越靠左上越稀。
	-->
	<div
		class="launcher-grid-mask pointer-events-none absolute top-1/2 right-0 bottom-0 left-1/2 -z-10 opacity-40"
	>
		<DitheredGrid density={0.4} glowRadius={140} fadeBottom={false} trackGlobal />
	</div>

	<!-- 顶部拖拽区:frameless 窗口需要一块可拖动的区域。macOS 的红绿灯就在这里。 -->
	<header class="drag-region shrink-0 px-7 pt-10 pb-6">
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
				<Button variant="icon" title={`主题:${theme.preference}`} onclick={() => theme.toggle()}>
					{#snippet icon()}
						<Icon name={theme.resolved === 'dark' ? 'moon' : 'sun'} />
					{/snippet}
				</Button>
			</div>
		</div>
	</header>

	<main class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_17rem] gap-8 px-7 pb-4">
		<section class="flex min-w-0 flex-col" aria-labelledby="recent-projects-heading">
			<div class="flex shrink-0 items-center gap-2 pb-3">
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

				<Button variant="primary" onclick={() => openDialog('local')}>
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

		<aside class="min-w-0 border-l border-subtle pl-6" aria-labelledby="workspace-heading">
			<div class="mb-3 flex h-7 items-center">
				<h2 id="workspace-heading" class="text-xs font-medium tracking-wide text-muted">工作台</h2>
			</div>
			<LauncherEntryList />
		</aside>
	</main>

	<KeyHintBar />
</div>

<NewProjectDialog bind:open={dialogOpen} initialHostType={dialogHostType} />

<!-- 非 macOS 平台没有原生 vibrancy,窗口底色必须不透明以免露出桌面 -->
{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}

<style>
	.launcher-grid-mask {
		mask-image: radial-gradient(
			115% 110% at 100% 100%,
			black 8%,
			rgba(0, 0, 0, 0.5) 42%,
			transparent 82%
		);
	}
</style>
