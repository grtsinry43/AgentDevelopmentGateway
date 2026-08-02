<script lang="ts">
	/**
	 * 工程窗口左上角的 JetBrains 式切换器。
	 *
	 * 扁平画风:没有外框,只有 hover/点击效果。两段:
	 *  - 主机(远程 hostname / 本地「本地」)+ 下拉:主机信息、管理主机、切换本主机工程;
	 *  - 工程名 + 下拉:最近工程列表,点击切换(打开目标工程窗口并关闭当前窗口)。
	 */
	import { onMount } from 'svelte';
	import { desktop, requireProjectIdentity } from '$lib/shared/bridge/desktop';
	import { pushBus } from '$lib/shared/bridge/events';
	import { remoteConnection } from '$lib/features/remote/remote.svelte';
	import { CONNECTION_STATE } from '$lib/shared/utils/status';
	import { basename } from '$lib/shared/utils/path';
	import { appError } from '../app-error.svelte';
	import { listRecentProjects } from '../api';
	import type { RecentProject } from '../types';
	import Icon from '$lib/ui/icons/Icon.svelte';

	const identity = requireProjectIdentity();
	const currentKey = identity.projectKey;
	const isRemote = identity.hostType === 'ssh';
	const hostLabel = identity.hostLabel ?? '本地';
	const projectName = basename(identity.projectPath.replace(/[/\\]+$/, ''));

	let projects = $state.raw<RecentProject[]>([]);
	let hostMenu = $state(false);
	let projectMenu = $state(false);

	onMount(() => {
		void listRecentProjects().then((list) => (projects = list));
		const off = pushBus.on('projects.changed', (event) => {
			projects = event.projects;
		});
		return off;
	});

	const current = $derived(projects.find((project) => project.key === currentKey));
	const hostProfileId = $derived(current?.hostProfileId);
	const statusVisual = $derived(
		isRemote ? CONNECTION_STATE[remoteConnection.state] : CONNECTION_STATE.connected
	);

	function formatBytes(bytes: number): string {
		if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
		if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
		return `${Math.round(bytes)} B`;
	}

	function formatDuration(seconds: number): string {
		const hours = Math.floor(seconds / 3_600);
		const minutes = Math.floor((seconds % 3_600) / 60);
		if (hours > 0) return `${hours}h ${minutes}m`;
		if (minutes > 0) return `${minutes}m ${Math.floor(seconds % 60)}s`;
		return `${Math.floor(seconds)}s`;
	}

	function closeMenus(): void {
		hostMenu = false;
		projectMenu = false;
	}

	/** 点击工程:弹出「在此窗口 / 新窗口打开」选择器(JetBrains 式)。 */
	async function switchProject(key: string): Promise<void> {
		if (key === currentKey) {
			closeMenus();
			return;
		}
		closeMenus();
		try {
			await desktop.projects.openChooser(key);
		} catch (cause) {
			// 选择器本身打不开(工程不存在等):错误弹窗展示,可取消。
			appError.show(cause);
		}
	}

	function openHostManager(): void {
		hostMenu = false;
		if (hostProfileId) void desktop.window.openHostManager(hostProfileId);
	}
</script>

<div class="flex min-w-0 items-center gap-0.5 text-xs text-muted">
	{#if isRemote}
		<!-- 主机(仅远程;本地无主机段,JetBrains 同款) -->
		<div class="relative">
			<button
				type="button"
				class="flex h-6 items-center gap-1.5 rounded px-1.5 transition-colors hover:bg-surface-hover hover:text-strong"
				title="切换主机 / 最近工程"
				onclick={() => {
					hostMenu = !hostMenu;
					projectMenu = false;
				}}
			>
				<Icon name={isRemote ? 'server' : 'monitor'} size={12} class="shrink-0 text-faint" />
				<span class="max-w-40 truncate font-medium text-normal">{hostLabel}</span>
				<span
					class={['size-1.5 shrink-0 rounded-full', statusVisual.dot]}
					class:animate-pulse={remoteConnection.state === 'connecting'}
				></span>
				<Icon name="chevron-down" size={10} class="shrink-0 text-faint" />
			</button>

			{#if hostMenu}
				<button
					type="button"
					class="fixed inset-0 z-40 cursor-default bg-transparent"
					aria-label="关闭主机菜单"
					onclick={closeMenus}
				></button>
				<div
					class="absolute top-7 left-0 z-50 w-72 rounded-default border border-line bg-surface-raised p-1 shadow-lg"
					role="menu"
				>
					{#if isRemote}
						<!-- 主机信息:地址 + 连接状态 + 资源占用。工程切换在第二个下拉里。 -->
						<div class="flex items-center gap-2 px-2.5 py-1.5">
							<span class="truncate font-mono text-2xs text-muted">
								{remoteConnection.status?.username
									? `${remoteConnection.status.username}@${hostLabel}`
									: hostLabel}
							</span>
							<span class={['text-2xs', statusVisual.text]}>{statusVisual.label}</span>
							<span class="flex-1"></span>
							<button
								type="button"
								class="text-2xs text-faint hover:text-strong"
								onclick={openHostManager}
							>
								管理主机
							</button>
						</div>

						{#if remoteConnection.status?.status}
							{@const s = remoteConnection.status.status}
							<div
								class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 px-2.5 py-2 text-2xs"
							>
								<span class="text-faint">平台</span>
								<span class="font-mono text-normal">
									{s.platform} · {s.arch} · {s.cpus} 核
								</span>
								<span class="text-faint">版本</span>
								<span class="font-mono text-normal">
									v{s.version}{remoteConnection.status.protocolVersion !== undefined
										? ` · 协议 ${remoteConnection.status.protocolVersion}`
										: ''}
								</span>
								<span class="text-faint">负载</span>
								<span class="font-mono text-normal">
									{s.loadAvg[0].toFixed(2)} / {s.loadAvg[1].toFixed(2)} / {s.loadAvg[2].toFixed(2)}
								</span>
								<span class="text-faint">内存</span>
								<div class="flex flex-col gap-0.5">
									<div class="bg-surface-subtle h-1 w-36 overflow-hidden rounded-full">
										<div
											class="h-full rounded-full bg-status-running"
											style:width="{Math.min(100, Math.max(2, s.memory.usagePercent))}%"
										></div>
									</div>
									<span class="font-mono text-2xs text-faint">
										{s.memory.usagePercent.toFixed(1)}% · {formatBytes(s.memory.freeBytes)} 空闲 /
										{formatBytes(s.memory.totalBytes)}
									</span>
								</div>
								<span class="text-faint">后端进程</span>
								<span class="font-mono text-normal">
									PID {s.gateway.pid} · RSS {formatBytes(s.gateway.rssBytes)} · 运行
									{formatDuration(s.uptimeSeconds)}
								</span>
							</div>
						{:else}
							<p class="px-2.5 pb-1.5 text-2xs text-faint">正在获取主机状态…</p>
						{/if}

						{#if remoteConnection.status?.stateMessage}
							<p class="px-2.5 pb-1 text-2xs text-faint">{remoteConnection.status.stateMessage}</p>
						{/if}
					{:else}
						<div class="px-2.5 py-1.5 text-2xs text-muted">本地主机</div>
						<p class="px-2.5 pb-1.5 text-2xs text-faint">在当前机器上运行;工程切换用右侧的下拉。</p>
					{/if}
				</div>
			{/if}
		</div>

		<span class="px-0.5 text-faint select-none">/</span>
	{/if}

	<!-- 工程 -->
	<div class="relative min-w-0">
		<button
			type="button"
			class="flex h-6 max-w-56 items-center gap-1 rounded px-1.5 transition-colors hover:bg-surface-hover hover:text-strong"
			title="切换最近工程"
			onclick={() => {
				projectMenu = !projectMenu;
				hostMenu = false;
			}}
		>
			<span class="truncate font-medium text-normal">{projectName}</span>
			<Icon name="chevron-down" size={10} class="shrink-0 text-faint" />
		</button>

		{#if projectMenu}
			<button
				type="button"
				class="fixed inset-0 z-40 cursor-default bg-transparent"
				aria-label="关闭工程菜单"
				onclick={closeMenus}
			></button>
			<div
				class="absolute top-7 left-0 z-50 w-80 rounded-default border border-line bg-surface-raised p-1 shadow-lg"
				role="menu"
			>
				<div class="px-2.5 py-1 text-2xs text-faint">最近工程</div>
				{#each projects as project (project.key)}
					<button
						type="button"
						role="menuitem"
						class={[
							'flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left text-xs',
							project.key === currentKey
								? 'bg-surface-active text-strong'
								: 'text-muted hover:bg-surface-hover hover:text-strong'
						]}
						title={project.path}
						onclick={() => void switchProject(project.key)}
					>
						<Icon
							name={project.hostType === 'ssh' ? 'server' : 'folder'}
							size={11}
							class="shrink-0 text-faint"
						/>
						<span class="min-w-0 flex-1 truncate">{project.name}</span>
						<span class="shrink-0 truncate font-mono text-2xs text-faint">{project.path}</span>
						{#if project.key === currentKey}
							<Icon name="check" size={10} class="shrink-0" />
						{/if}
					</button>
				{:else}
					<p class="px-2.5 py-1 text-2xs text-faint">还没有工程。</p>
				{/each}
			</div>
		{/if}
	</div>
</div>
