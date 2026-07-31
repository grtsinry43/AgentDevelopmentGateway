/// <reference types="svelte" />
/// <reference types="vite/client" />

import type { DesktopBridge } from '$contract/bridge';

declare global {
	interface Window {
		/** preload 通过 contextBridge 暴露。渲染进程只应通过 $lib/shared/bridge 访问。 */
		gateway: DesktopBridge;
	}
}
