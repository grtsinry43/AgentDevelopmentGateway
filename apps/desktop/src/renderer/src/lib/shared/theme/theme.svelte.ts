/**
 * 主题管理。移植 grtblog 的 ThemeManager 形态:class + `$state` 字段,导出单例。
 *
 * 与 grtblog 的差异:桌面应用的「跟随系统」由 Electron 主进程的 nativeTheme 权威提供,
 * 而不是靠渲染进程的 matchMedia —— 主进程能拿到更准的值(且 Windows 上 matchMedia
 * 在某些版本不跟随系统设置)。这里两条来源都监听,以主进程为准、matchMedia 为兜底。
 */

import { pushBus } from '$lib/shared/bridge/events';
import { systemInfo } from '$lib/shared/bridge/desktop';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'agent-gateway:theme';

function readStoredPreference(): ThemePreference {
	const raw = localStorage.getItem(STORAGE_KEY);
	return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

class ThemeManager {
	/** 用户偏好。'system' 表示跟随系统。 */
	preference = $state<ThemePreference>('system');
	/** 系统当前是否暗色。由主进程 nativeTheme / matchMedia 推入。 */
	systemDark = $state(false);

	/** 实际生效的主题。这是组件该读的值。 */
	readonly resolved = $derived<ResolvedTheme>(
		this.preference === 'system' ? (this.systemDark ? 'dark' : 'light') : this.preference
	);

	set(preference: ThemePreference): void {
		this.preference = preference;
		localStorage.setItem(STORAGE_KEY, preference);
	}

	/** 在 light / dark 之间切换。从 'system' 出发时切到与当前相反的显式值。 */
	toggle(): void {
		this.set(this.resolved === 'dark' ? 'light' : 'dark');
	}
}

export const theme = new ThemeManager();

/**
 * 固定浅色主题(导出等需要纯色、无装饰背景的场合)。
 * 去掉 `.dark` 类让 token 走浅色分支,并强制 color-scheme。
 */
export function forceLightTheme(): void {
	document.documentElement.classList.remove('dark');
	document.documentElement.style.colorScheme = 'light';
}

/**
 * 把 theme 状态同步到 DOM,并订阅系统主题变化。
 *
 * 必须在窗口根组件里调用一次(它内部用 `$effect`,只能在组件初始化期间调用)。
 */
export function startThemeSync(manager: ThemeManager = theme): void {
	// 初始值都是同步可得的:localStorage 是同步 API,系统暗色由主进程随窗口注入。
	// 这样首帧就是正确主题,不会先亮一下再切暗。
	manager.preference = readStoredPreference();
	manager.systemDark = systemInfo.shouldUseDarkColors;

	// 系统主题变化:主进程 nativeTheme 推送(权威),matchMedia 兜底。
	// 两条来源都只写 systemDark,不读它 —— 否则又是 effect 自我失效
	// (参见 shared/keymap 里踩过的坑)。
	$effect(() => {
		const unsubscribe = pushBus.on('theme.changed', (event) => {
			manager.systemDark = event.isDark;
		});

		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const onMediaChange = (event: MediaQueryListEvent): void => {
			manager.systemDark = event.matches;
		};
		media.addEventListener('change', onMediaChange);

		return () => {
			unsubscribe();
			media.removeEventListener('change', onMediaChange);
		};
	});

	// 应用到 DOM。只读 resolved、只写 DOM,不写任何 $state。
	$effect(() => {
		const resolved = manager.resolved;
		document.documentElement.classList.toggle('dark', resolved === 'dark');
		// 让原生控件(滚动条、输入法候选框、表单控件)跟随主题
		document.documentElement.style.colorScheme = resolved;
	});
}
