/**
 * 远程连接状态容器(仅 hostType = ssh 的工程使用)。
 *
 * 状态有两个来源:
 *  - 首帧 fetchRemoteStatus():拿当前连接状态 + 主机信息 + 资源快照;
 *  - 主进程 remote.state 推送:隧道断开/重连/失败时实时更新 state。
 * 资源占用只在面板打开时拉取,不做常驻轮询(跨 SSH 的轮询是浪费)。
 */

import { pushBus } from '$lib/shared/bridge/events';
import type { ConnectionState } from '$contract/hosts';
import type { RemoteStatus } from '$contract/bridge';
import {
	fetchRemoteStatus,
	reconnectRemote as apiReconnect,
	disconnectRemote as apiDisconnect
} from './api';

class RemoteConnectionStore {
	/** 是否远程工程。本地工程没有这个 chip。 */
	isRemote = $state(false);
	status = $state.raw<RemoteStatus | undefined>(undefined);
	/** 拉取状态时是否还在加载。 */
	loading = $state(true);
	/** 最近一次错误(重连/断开失败等)。 */
	error = $state<string | undefined>(undefined);
	state = $state<ConnectionState>('disconnected');
	#projectKey: string | undefined = undefined;

	async start(projectKey: string): Promise<void> {
		this.#projectKey = projectKey;
		this.loading = true;
		try {
			const status = await fetchRemoteStatus(projectKey);
			this.status = status;
			this.isRemote = status.isRemote;
			this.state = status.state ?? 'disconnected';
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.loading = false;
		}
	}

	/** 在窗口根组件的 $effect 里调用,返回退订函数。 */
	watch(): () => void {
		return pushBus.on('remote.state', (event) => {
			if (this.status?.hostProfileId !== event.hostProfileId) return;
			this.state = event.state;
		});
	}

	/** 面板打开时拉一次最新状态(含资源快照)。 */
	async refresh(): Promise<void> {
		if (!this.#projectKey) return;
		this.loading = true;
		try {
			this.status = await fetchRemoteStatus(this.#projectKey);
			this.state = this.status.state ?? 'disconnected';
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.loading = false;
		}
	}

	async reconnect(): Promise<void> {
		if (!this.#projectKey) return;
		this.error = undefined;
		this.state = 'connecting';
		try {
			await apiReconnect(this.#projectKey);
			await this.refresh();
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
			this.state = 'error';
		}
	}

	async disconnect(): Promise<void> {
		if (!this.#projectKey) return;
		this.error = undefined;
		try {
			await apiDisconnect(this.#projectKey);
			this.state = 'disconnected';
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		}
	}
}

export const remoteConnection = new RemoteConnectionStore();
