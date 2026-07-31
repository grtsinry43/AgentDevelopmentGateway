/**
 * preload bridge 的类型化入口。
 *
 * 渲染进程**只能**通过这里访问 `window.gateway`,不要在业务代码里直接摸全局对象 ——
 * 这样将来换传输(比如 Web 客户端走 HTTP 而非 IPC)只需要换这个文件的实现。
 */

import type { DesktopBridge } from '$contract/bridge';

function resolveBridge(): DesktopBridge {
	const bridge = (globalThis as { gateway?: DesktopBridge }).gateway;
	if (!bridge) {
		// preload 没跑成功是致命配置错误,早失败早发现,不要静默降级
		throw new Error('window.gateway 不可用 —— preload 未加载');
	}
	return bridge;
}

export const desktop: DesktopBridge = resolveBridge();

/** 当前窗口身份。Launcher 与 Project 是两个独立 BrowserWindow。 */
export const identity = desktop.identity;

/** 主进程注入的系统信息(platform / homeDir / 版本 / 系统是否暗色)。 */
export const systemInfo = desktop.info;

/**
 * Project 窗口必需的 projectKey。在 Launcher 窗口里调用是编程错误。
 */
export function requireProjectKey(): string {
	if (identity.kind !== 'project' || !identity.projectKey) {
		throw new Error(`当前窗口不是 project 窗口(kind=${identity.kind})`);
	}
	return identity.projectKey;
}
