/**
 * 远程 server 日志串流的状态容器。
 *
 * 面板挂载时订阅 remote.log / remote.logState,hostProfileId 就绪后调用 start
 * (主进程经 ssh tail -F)。行数封顶,超出丢弃最旧。
 */

import { pushBus } from '$lib/shared/bridge/events';
import { desktop } from '$lib/shared/bridge/desktop';
import { parseServerLogLine, type ParsedLogEntry } from './log-format';

const MAX_ENTRIES = 2_000;

class RemoteLogStore {
	entries = $state.raw<ParsedLogEntry[]>([]);
	streaming = $state(false);
	error = $state<string | undefined>(undefined);
	/** 所属主机的 hostProfileId;事件按它过滤,避免多窗口互相串流。 */
	hostProfileId = $state<string | undefined>(undefined);

	async start(hostProfileId: string): Promise<void> {
		this.hostProfileId = hostProfileId;
		this.clear();
		try {
			await desktop.remote.logStart(hostProfileId);
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async stop(): Promise<void> {
		const hostProfileId = this.hostProfileId;
		this.hostProfileId = undefined;
		if (!hostProfileId) return;
		try {
			await desktop.remote.logStop(hostProfileId);
		} catch {
			// 主进程侧流可能已随连接断开,忽略。
		}
		this.streaming = false;
	}

	/** 在窗口根组件的 $effect 里调用,返回退订函数。 */
	watch(): () => void {
		const offLog = pushBus.on('remote.log', (event) => {
			if (event.hostProfileId !== this.hostProfileId) return;
			const parsed = event.lines.map((line) => parseServerLogLine(line));
			this.entries = [...this.entries, ...parsed].slice(-MAX_ENTRIES);
		});
		const offState = pushBus.on('remote.logState', (event) => {
			if (event.hostProfileId !== this.hostProfileId) return;
			this.streaming = event.streaming;
			if (event.error) this.error = event.error;
		});
		return () => {
			offLog();
			offState();
		};
	}

	clear(): void {
		this.entries = [];
		this.error = undefined;
	}
}

export const remoteLog = new RemoteLogStore();
