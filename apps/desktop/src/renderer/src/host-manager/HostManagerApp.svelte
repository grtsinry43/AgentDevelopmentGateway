<script lang="ts">
	/**
	 * 主机管理中心窗口。显示后端版本/资源/启停/重装与远程日志,独立窗口承载
	 * (IDE 风格,不做模态弹窗)。
	 */
	import { onMount } from 'svelte';
	import { startThemeSync } from '$lib/shared/theme/theme.svelte';
	import { CONNECTION_STATE } from '$lib/shared/utils/status';
	import { cx } from '$lib/shared/utils/cx';
	import { hostsStore } from '$lib/features/project/hosts.svelte';
	import { hostDetail } from '$lib/features/remote/host-detail.svelte';
	import { remoteLog } from '$lib/features/remote/log-store.svelte';
	import RemoteLogView from '$lib/features/remote/components/RemoteLogView.svelte';
	import { identity, systemInfo } from '$lib/shared/bridge/desktop';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	startThemeSync();
	void hostsStore.load();

	if (identity.kind !== 'host-manager') {
		throw new Error(`当前窗口不是 host-manager 窗口(kind=${identity.kind})`);
	}
	const hostProfileId = identity.hostProfileId;

	const detail = $derived(hostDetail.detail);
	const visual = $derived(CONNECTION_STATE[detail?.state ?? 'disconnected']);

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

	onMount(() => {
		void hostDetail.openById(hostProfileId);
		void remoteLog.start(hostProfileId);
		const unwatch = remoteLog.watch();
		return () => {
			unwatch();
			void remoteLog.stop();
		};
	});
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface-base">
	<TitleBar title="远程主机" subtitle={detail?.profile.name ?? ''} />

	<main class="min-h-0 flex-1 overflow-y-auto p-5">
		<div class="flex flex-col gap-4">
			{#if detail}
				<div class="flex items-center gap-2">
					<span class="font-mono text-xs text-muted">
						{detail.profile.username}@{detail.profile.hostname}:{detail.profile.port}
					</span>
					<span class={cx('text-2xs', visual.text)}>{visual.label}</span>
				</div>

				<div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-2xs">
					<span class="text-faint">已安装版本</span>
					<span class="font-mono text-normal">
						{detail.installedVersion ?? '未安装'}{detail.installedProtocol !== undefined
							? ` · 协议 ${detail.installedProtocol}`
							: ''}
					</span>
					<span class="text-faint">连接版本</span>
					<span class="font-mono text-normal">
						{detail.connectedVersion
							? `v${detail.connectedVersion}${detail.protocolVersion !== undefined ? ` · 协议 ${detail.protocolVersion}` : ''}`
							: '未连接'}
					</span>

					{#if detail.status}
						{@const s = detail.status}
						<span class="text-faint">平台</span>
						<span class="font-mono text-normal">{s.platform} · {s.arch} · {s.cpus} 核</span>
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
					{/if}
				</div>

				{#if hostDetail.error}
					<p class="text-xs text-cinnabar-600 dark:text-cinnabar-400">{hostDetail.error}</p>
				{/if}
				{#if detail.stateMessage}
					<p class="text-2xs text-faint">{detail.stateMessage}</p>
				{/if}

				<div class="flex flex-wrap items-center gap-1.5">
					<Button
						size="sm"
						variant="primary"
						loading={hostDetail.busy}
						onclick={() => void hostDetail.start()}
					>
						启动后端
					</Button>
					<Button
						size="sm"
						variant="secondary"
						loading={hostDetail.busy}
						onclick={() => void hostDetail.stop()}
					>
						停止后端
					</Button>
					<Button
						size="sm"
						variant="secondary"
						loading={hostDetail.busy}
						onclick={() => void hostDetail.restart()}
					>
						重启
					</Button>
					<Button
						size="sm"
						variant="secondary"
						loading={hostDetail.busy}
						onclick={() => void hostDetail.reinstall()}
					>
						重装
					</Button>
					<span class="flex-1"></span>
					<Button
						size="sm"
						variant="ghost"
						loading={hostDetail.busy}
						onclick={() => void hostDetail.refresh()}
					>
						{#snippet icon()}
							<Icon name="search" size={11} />
						{/snippet}
						刷新
					</Button>
				</div>
			{:else}
				<p class="text-2xs text-faint">加载主机信息…</p>
			{/if}

			<div class="flex flex-col gap-1">
				<span class="flex items-center gap-1.5 text-2xs text-muted">
					<Icon name="log" size={11} />
					远程日志
				</span>
				<div class="h-56 overflow-hidden rounded-default border border-subtle p-1.5">
					<RemoteLogView />
				</div>
			</div>
		</div>
	</main>
</div>

{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
