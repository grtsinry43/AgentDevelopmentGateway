import type { PortForwardWire } from '$contract/bridge';
import { desktop } from '$lib/shared/bridge/desktop';
import { pushBus } from '$lib/shared/bridge/events';

/**
 * 端口转发状态(仅远程工程有意义)。
 *
 * 唯一事实源在主进程 RemoteConnectionManager:预览自动建的隧道、手动绑定的转发
 * 都由它持有,变化经 `ports.changed` 广播。这里只投影**当前工程主机**的转发集合,
 * 命令返回不改本地状态 —— 一次广播一条路径(AGENTS.md)。
 */
class PortsStore {
	/** 当前工程主机的 SSH profile id(local 工程为 undefined)。 */
	hostProfileId = $state<string | undefined>(undefined);
	forwards = $state<PortForwardWire[]>([]);
	loading = $state(false);

	async load(projectKey: string): Promise<void> {
		this.loading = true;
		try {
			const result = await desktop.ports.list(projectKey);
			this.hostProfileId = result.hostProfileId;
			this.forwards = result.forwards;
		} catch {
			this.hostProfileId = undefined;
			this.forwards = [];
		} finally {
			this.loading = false;
		}
	}

	/** 订阅主进程广播,只认当前主机的转发变化。 */
	watch(): () => void {
		return pushBus.on('ports.changed', (event) => {
			if (event.hostProfileId !== this.hostProfileId) return;
			this.forwards = event.forwards;
		});
	}

	/** 手动绑定远端端口 → 本地(广播会同步 forwards)。 */
	async bind(projectKey: string, remotePort: number): Promise<void> {
		await desktop.ports.bind(projectKey, remotePort);
	}

	async close(projectKey: string, remotePort: number): Promise<void> {
		await desktop.ports.close(projectKey, remotePort);
	}
}

export const portsStore = new PortsStore();
