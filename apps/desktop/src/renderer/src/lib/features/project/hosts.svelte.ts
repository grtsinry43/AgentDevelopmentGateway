/**
 * SSH 主机列表的状态容器 + 远程连接进度。
 *
 * 与 launcher.svelte.ts 同一约定:写操作不消费返回值,等主进程 `hosts.changed`
 * 推送(单一数据到达路径)。provision 进度按 hostProfileId 记录,新建工程对话框
 * 据此显示内联状态。
 */

import { pushBus } from '$lib/shared/bridge/events';
import type { HostProbeResult } from '$contract/bridge';
import { listHosts } from './api';
import type { HostProfile, RecentProject, RemoteProvisionStage } from './types';

export interface RemoteProgress {
	stage: RemoteProvisionStage;
	message?: string;
}

/** Launcher 主机的在线展示状态(由探测结果推导)。 */
export type HostOnlineState = 'checking' | 'online' | 'stopped' | 'offline';

export function hostOnlineState(
	probe: HostProbeResult | undefined,
	probing: boolean
): HostOnlineState {
	if (probing || !probe) return 'checking';
	if (!probe.sshReachable) return 'offline';
	return probe.serverRunning ? 'online' : 'stopped';
}

/** 工程的展示主机标签:远程 = hostname(IP/域名),本地 = 无。hostId(UUID)不做展示。 */
export function hostLabelForProject(project: RecentProject): string | undefined {
	if (project.hostType === 'local') return undefined;
	const host = hostsStore.hosts.find((entry) => entry.id === project.hostProfileId);
	return host?.hostname ?? project.hostId.slice(0, 8);
}

class HostsStore {
	hosts = $state.raw<HostProfile[]>([]);
	loading = $state(true);
	/** hostProfileId → 最近一次连接进度。 */
	progress = $state.raw<Readonly<Record<string, RemoteProgress>>>({});
	/** 最近一条进度事件(新建主机时对话框还不知道 profileId,只能看最新)。 */
	latest = $state.raw<(RemoteProgress & { hostProfileId: string }) | undefined>(undefined);
	/** hostProfileId → 在线探测结果(Launcher 分组)。 */
	probes = $state.raw<Readonly<Record<string, HostProbeResult>>>({});
	/** 正在探测的主机 id(探测中显示「检测中」)。 */
	probingHosts = $state.raw<string[]>([]);

	async load(): Promise<void> {
		this.loading = true;
		try {
			this.hosts = await listHosts();
		} finally {
			this.loading = false;
		}
	}

	/** 探测全部主机的 SSH 可达性与 server 运行状态。 */
	async probeAll(): Promise<void> {
		const ids = this.hosts.map((host) => host.id);
		this.probingHosts = ids;
		try {
			const results = await import('$lib/features/remote/api').then((api) => api.probeHosts());
			const next: Record<string, HostProbeResult> = {};
			for (const result of results) next[result.hostProfileId] = result;
			this.probes = next;
		} finally {
			this.probingHosts = [];
		}
	}

	/** 在窗口根组件的 $effect 里调用,返回退订函数。 */
	watch(): () => void {
		const offHosts = pushBus.on('hosts.changed', (event) => {
			this.hosts = event.hosts;
		});
		const offProbes = pushBus.on('remote.hostsProbed', (event) => {
			const next: Record<string, HostProbeResult> = {};
			for (const result of event.hosts) next[result.hostProfileId] = result;
			this.probes = next;
		});
		const offProgress = pushBus.on('remote.progress', (event) => {
			const entry: RemoteProgress = {
				stage: event.stage,
				...(event.message ? { message: event.message } : {})
			};
			this.progress = { ...this.progress, [event.hostProfileId]: entry };
			this.latest = { hostProfileId: event.hostProfileId, ...entry };
		});
		return () => {
			offHosts();
			offProbes();
			offProgress();
		};
	}
}

export const hostsStore = new HostsStore();
