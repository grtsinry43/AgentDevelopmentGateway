<script lang="ts">
	/**
	 * Launcher 的「远程开发」区:主机分组,JetBrains Gateway 形态。
	 *
	 * 每台主机显示:名称、地址、在线状态(SSH 可达 + server 运行),可展开看到该主机的
	 * 工程;右键(或 hover 的 …)菜单提供 刷新 / 停止 Server / 删除主机。
	 * 工程右键菜单提供 打开 / 删除。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import {
		hostsStore,
		hostOnlineState,
		type HostOnlineState
	} from '$lib/features/project/hosts.svelte';
	import { launcher } from '$lib/features/project/launcher.svelte';
	import type { HostProfile, RecentProject } from '$lib/features/project/types';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';

	const onlineVisual: Record<HostOnlineState, { dot: string; label: string }> = {
		checking: { dot: 'bg-status-connecting', label: '检测中' },
		online: { dot: 'bg-status-online', label: '在线' },
		stopped: { dot: 'bg-status-offline', label: 'Server 已停止' },
		offline: { dot: 'bg-status-error', label: '离线' }
	};

	/** host → 该主机下的工程。 */
	const groups = $derived.by(() => {
		const byHost: Record<string, RecentProject[]> = {};
		for (const project of launcher.remoteProjects) {
			const id = project.hostProfileId ?? '';
			(byHost[id] ??= []).push(project);
		}
		return hostsStore.hosts.map((host) => ({
			host,
			projects: byHost[host.id] ?? [],
			online: hostOnlineState(hostsStore.probes[host.id], hostsStore.probingHosts.includes(host.id))
		}));
	});

	let expanded = $state.raw<Record<string, boolean>>({});

	function toggleHost(hostId: string): void {
		expanded = { ...expanded, [hostId]: !expanded[hostId] };
	}

	function openHostMenu(event: MouseEvent, host: HostProfile): void {
		launcher.openHostMenu(event, host);
	}

	function formatHostAddress(host: HostProfile): string {
		return `${host.username}@${host.hostname}:${host.port}`;
	}
</script>

{#if groups.length === 0}
	<EmptyState
		title="还没有远程主机"
		description="⌘⇧N 新建远程工程时会登记主机,或在这里直接创建。"
		compact
	/>
{:else}
	<div class="flex flex-col gap-1">
		{#each groups as { host, projects, online } (host.id)}
			<div class="flex flex-col overflow-hidden rounded-default border border-subtle">
				<div
					role="button"
					tabindex="0"
					class="group flex h-8 cursor-pointer items-center gap-2 px-2.5 text-left hover:bg-surface-hover"
					onclick={() => toggleHost(host.id)}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							toggleHost(host.id);
						}
					}}
					oncontextmenu={(event) => openHostMenu(event, host)}
				>
					<Icon
						name={expanded[host.id] ? 'chevron-down' : 'chevron-right'}
						size={10}
						class="shrink-0 text-faint"
					/>
					<Icon name="server" size={12} class="shrink-0 text-faint" />
					<span class="truncate text-xs font-medium text-strong">{host.name}</span>
					<span class="truncate font-mono text-2xs text-faint">{formatHostAddress(host)}</span>
					<span
						class={cx(
							'shrink-0 rounded-full px-1.5 py-0.5 text-2xs',
							online === 'online'
								? 'text-status-online'
								: online === 'offline'
									? 'text-status-error'
									: online === 'stopped'
										? 'text-status-offline'
										: 'text-status-connecting'
						)}
					>
						{onlineVisual[online].label}
					</span>
					<span class="flex-1"></span>
					<button
						type="button"
						class="flex h-5 w-5 items-center justify-center rounded-[3px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-strong"
						title="主机操作"
						onclick={(event) => {
							event.stopPropagation();
							openHostMenu(event, host);
						}}
					>
						<Icon name="list" size={11} />
					</button>
				</div>

				{#if expanded[host.id]}
					<div class="border-t border-subtle">
						{#if projects.length === 0}
							<p class="px-3 py-2 text-2xs text-faint">该主机下还没有工程。</p>
						{:else}
							{#each projects as project (project.key)}
								<button
									type="button"
									class="flex h-7 w-full items-center gap-2 px-3 text-left text-2xs hover:bg-surface-hover"
									onclick={() => void launcher.openProject(project.key)}
									oncontextmenu={(event) => launcher.openProjectMenu(event, project, true)}
								>
									<span class="truncate font-mono text-muted">{project.path}</span>
									<span class="flex-1"></span>
									<span class="shrink-0 text-2xs text-faint">{project.name}</span>
								</button>
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		{/each}

		<div class="mt-1 flex items-center justify-end gap-1">
			<Button
				size="sm"
				variant="ghost"
				loading={hostsStore.probingHosts.length > 0}
				onclick={() => void hostsStore.probeAll()}
			>
				{#snippet icon()}
					<Icon name="search" size={11} />
				{/snippet}
				刷新状态
			</Button>
		</div>
	</div>
{/if}
