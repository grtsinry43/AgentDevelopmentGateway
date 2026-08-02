/**
 * 远程主机详情(管理中心对话框)的状态容器。
 *
 * detail 只在打开对话框/点刷新/动作完成时拉取,不做常驻轮询;provision 中间态
 * 走 hostsStore 的 remote.progress(已按 host 记录)。remote.state 推送会触发
 * 一次静默刷新,让「停止后端」这类动作后状态立刻正确。
 */

import { pushBus } from '$lib/shared/bridge/events';
import { desktop } from '$lib/shared/bridge/desktop';
import type { HostDetailData } from '$contract/bridge';

class HostDetailStore {
	detail = $state.raw<HostDetailData | undefined>(undefined);
	busy = $state(false);
	error = $state<string | undefined>(undefined);
	#hostId: string | undefined = undefined;

	async openById(hostProfileId: string): Promise<void> {
		this.#hostId = hostProfileId;
		this.error = undefined;
		await this.refresh();
	}

	/** 在窗口根组件的 $effect 里调用,返回退订函数。 */
	watch(): () => void {
		return pushBus.on('remote.state', (event) => {
			if (event.hostProfileId === this.#hostId) void this.refresh();
		});
	}

	async refresh(): Promise<void> {
		if (!this.#hostId) return;
		try {
			this.detail = await desktop.remote.hostDetail(this.#hostId);
			this.error = undefined;
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async #run(action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.error = undefined;
		try {
			await action();
			await this.refresh();
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.busy = false;
		}
	}

	start(): Promise<void> {
		if (!this.#hostId) return Promise.resolve();
		return this.#run(() => desktop.remote.hostStart(this.#hostId!));
	}

	stop(): Promise<void> {
		if (!this.#hostId) return Promise.resolve();
		return this.#run(() => desktop.remote.stopServer(this.#hostId!));
	}

	restart(): Promise<void> {
		if (!this.#hostId) return Promise.resolve();
		return this.#run(() => desktop.remote.hostRestart(this.#hostId!));
	}

	reinstall(): Promise<void> {
		if (!this.#hostId) return Promise.resolve();
		return this.#run(() => desktop.remote.hostReinstall(this.#hostId!));
	}
}

export const hostDetail = new HostDetailStore();
