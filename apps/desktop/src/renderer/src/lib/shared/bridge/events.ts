/**
 * 主进程推送事件的分发层。
 *
 * preload 只给了一个「所有事件的单一回调」。业务代码需要的是「我只关心
 * projects.changed」,所以这里做一次按 kind 的分发,形态照 grtblog 的
 * `shared/ws/realtime-core.ts`:listener Set + 返回退订函数。
 *
 * 为什么不让每个组件各自 `desktop.subscribe`:
 *   - 每个订阅都会在 preload 侧新增一个 `ipcRenderer.on`,组件多了就是几十个
 *   - 业务代码得自己写 `if (event.kind === ...)`,重复且容易漏
 *   - 无法在一处做日志/调试
 */

import type { PushEvent, PushEventKind } from '$contract/bridge';
import { desktop } from './desktop';

type Handler<K extends PushEventKind> = (event: Extract<PushEvent, { kind: K }>) => void;

class PushBus {
	/** kind → 该 kind 的所有 listener。 */
	#listeners = new Map<PushEventKind, Set<(event: PushEvent) => void>>();
	#unsubscribe: (() => void) | null = null;

	/**
	 * 订阅某类事件。返回退订函数。
	 *
	 * 首个订阅时才真正接上 preload 通道,最后一个退订时断开 —— 没人听的时候
	 * 不该占着 IPC 监听。
	 */
	on<K extends PushEventKind>(kind: K, handler: Handler<K>): () => void {
		let set = this.#listeners.get(kind);
		if (!set) {
			set = new Set();
			this.#listeners.set(kind, set);
		}

		const wrapped = handler as (event: PushEvent) => void;
		set.add(wrapped);
		this.#ensureConnected();

		return () => {
			set?.delete(wrapped);
			if (set?.size === 0) this.#listeners.delete(kind);
			this.#disconnectIfIdle();
		};
	}

	#ensureConnected(): void {
		if (this.#unsubscribe) return;
		this.#unsubscribe = desktop.subscribe((event) => this.#dispatch(event));
	}

	#disconnectIfIdle(): void {
		if (this.#listeners.size > 0) return;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	#dispatch(event: PushEvent): void {
		const set = this.#listeners.get(event.kind);
		if (!set) return;
		// 复制一份再遍历:handler 里可能退订自己,直接遍历会改动中的 Set
		for (const handler of [...set]) {
			try {
				handler(event);
			} catch (error) {
				// 一个 handler 抛错不该拖垮其他 handler
				console.error(`[push] ${event.kind} handler 抛错:`, error);
			}
		}
	}
}

export const pushBus = new PushBus();
