/**
 * Web 预览状态。agent 调用 `preview(port)` 工具后,session workspace 经主进程解析出
 * 客户端可访问的地址(远程走 SSH 中转),写入这里;ProjectApp 监听到就打开右侧预览
 * 面板并最大化。`host`+`port` 是 iframe/webview 白名单依据。
 */
export interface PreviewEntry {
	url: string;
	/** 允许的 host(本地 localhost / 远程中转 127.0.0.1)。 */
	host: string;
	/** 允许的端口。 */
	port: number;
}

class WebPreviewStore {
	entry = $state<PreviewEntry | undefined>(undefined);
	/** 每次 open/reload 递增,用于强制重建 webview(agent 重复调用 preview 也要刷新)。 */
	revision = $state(0);
	#subscribers = new Set<(entry: PreviewEntry | undefined) => void>();

	get url(): string | undefined {
		return this.entry?.url;
	}

	/** 订阅 entry 变化(命令式回调,避免在 $effect 里读写 $state 造成死循环)。 */
	subscribe(callback: (entry: PreviewEntry | undefined) => void): () => void {
		this.#subscribers.add(callback);
		return () => this.#subscribers.delete(callback);
	}

	#emit(): void {
		for (const callback of this.#subscribers) callback(this.entry);
	}

	open(entry: PreviewEntry): void {
		this.entry = entry;
		this.revision += 1;
		this.#emit();
	}

	/** 手动/重复调用预览时刷新当前页面。 */
	reload(): void {
		if (!this.entry) return;
		this.revision += 1;
	}

	clear(): void {
		this.entry = undefined;
		this.revision += 1;
		this.#emit();
	}
}

export const webPreview = new WebPreviewStore();
