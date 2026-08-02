/**
 * 工程窗口的全局错误弹窗。操作类失败(切换工程等)用弹窗展示,不占界面内容区。
 */

class AppErrorStore {
	error = $state<string | undefined>(undefined);

	show(cause: unknown): void {
		this.error = cause instanceof Error ? cause.message : String(cause);
	}

	dismiss(): void {
		this.error = undefined;
	}
}

export const appError = new AppErrorStore();
