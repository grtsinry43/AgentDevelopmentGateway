/**
 * 工作区布局状态。
 *
 * 布局是**用户偏好**,不是会话状态 —— 所以由主进程按 projectKey 持久化,
 * 而不是塞进 localStorage(那样多窗口会互相覆盖)。
 *
 * 写盘做了防抖:拖动分隔条会产生几十次 commit,每次都写盘是浪费。
 */

import type { DockPanelState, WorkspaceLayoutState } from '$contract/bridge';
import { desktop, requireProjectKey } from '$lib/shared/bridge/desktop';

export const LEFT_TABS = ['sessions', 'context', 'git', 'files'] as const;
export type LeftTab = (typeof LEFT_TABS)[number];

const DEFAULT_LAYOUT: WorkspaceLayoutState = {
	leftWidth: 236,
	rightWidth: 320,
	leftCollapsed: false,
	rightCollapsed: false,
	leftTab: 'sessions',
	rightPanels: [
		{ id: 'tasks-1', type: 'tasks', weight: 1, collapsed: false },
		{ id: 'terminal-1', type: 'terminal', weight: 1, collapsed: false }
	]
};

const SAVE_DEBOUNCE_MS = 400;

class WorkspaceLayout {
	leftWidth = $state(DEFAULT_LAYOUT.leftWidth);
	rightWidth = $state(DEFAULT_LAYOUT.rightWidth);
	leftCollapsed = $state(DEFAULT_LAYOUT.leftCollapsed);
	rightCollapsed = $state(DEFAULT_LAYOUT.rightCollapsed);
	leftTab = $state<LeftTab>('sessions');
	/** 右侧 dock 的面板列表。整体重新赋值,不做原地 mutation。 */
	panels = $state.raw<DockPanelState[]>(DEFAULT_LAYOUT.rightPanels);
	/** 布局是否已从磁盘读回。false 时不该写盘(否则会用默认值覆盖用户设置)。 */
	hydrated = $state(false);

	#timer: ReturnType<typeof setTimeout> | undefined;
	#counter = 0;

	/** 从主进程读回布局。异步,不阻塞首帧 —— 先用默认值渲染。 */
	async load(): Promise<void> {
		try {
			const saved = await desktop.layout.get(requireProjectKey());
			if (saved) this.#apply(saved);
		} catch (error) {
			console.error('[layout] 读取失败,使用默认布局:', error);
		} finally {
			this.hydrated = true;
		}
	}

	#apply(state: WorkspaceLayoutState): void {
		this.leftWidth = state.leftWidth;
		this.rightWidth = state.rightWidth;
		this.leftCollapsed = state.leftCollapsed;
		this.rightCollapsed = state.rightCollapsed;
		this.leftTab = (LEFT_TABS as readonly string[]).includes(state.leftTab)
			? (state.leftTab as LeftTab)
			: 'sessions';
		this.panels = state.rightPanels;
	}

	#snapshot(): WorkspaceLayoutState {
		return {
			leftWidth: this.leftWidth,
			rightWidth: this.rightWidth,
			leftCollapsed: this.leftCollapsed,
			rightCollapsed: this.rightCollapsed,
			leftTab: this.leftTab,
			rightPanels: this.panels
		};
	}

	/**
	 * 防抖写盘。拖动分隔条会连续 commit 几十次,不该每次都落盘。
	 * 注意 `#snapshot()` 在 setTimeout 里读 —— 保证写的是最新值。
	 */
	#persist(): void {
		if (!this.hydrated) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			void desktop.layout
				.save(requireProjectKey(), this.#snapshot())
				.catch((error) => console.error('[layout] 保存失败:', error));
		}, SAVE_DEBOUNCE_MS);
	}

	setLeftWidth(value: number): void {
		this.leftWidth = value;
		this.#persist();
	}

	setRightWidth(value: number): void {
		this.rightWidth = value;
		this.#persist();
	}

	toggleLeft(): void {
		this.leftCollapsed = !this.leftCollapsed;
		this.#persist();
	}

	toggleRight(): void {
		this.rightCollapsed = !this.rightCollapsed;
		this.#persist();
	}

	setLeftTab(tab: LeftTab): void {
		// 点当前 tab = 折叠侧栏(和 VSCode 一致的手感)
		if (this.leftTab === tab && !this.leftCollapsed) {
			this.toggleLeft();
			return;
		}
		this.leftTab = tab;
		this.leftCollapsed = false;
		this.#persist();
	}

	addPanel(type: string): void {
		const id = `${type}-${Date.now().toString(36)}-${this.#counter++}`;
		this.panels = [...this.panels, { id, type, weight: 1, collapsed: false }];
		this.rightCollapsed = false;
		this.#persist();
	}

	removePanel(id: string): void {
		this.panels = this.panels.filter((panel) => panel.id !== id);
		this.#persist();
	}

	togglePanel(id: string): void {
		this.panels = this.panels.map((panel) =>
			panel.id === id ? { ...panel, collapsed: !panel.collapsed } : panel
		);
		this.#persist();
	}

	/** 调整某个面板与其下一个面板的权重分配(拖动它们之间的分隔条)。 */
	setPanelWeights(id: string, weight: number, nextId: string, nextWeight: number): void {
		this.panels = this.panels.map((panel) => {
			if (panel.id === id) return { ...panel, weight };
			if (panel.id === nextId) return { ...panel, weight: nextWeight };
			return panel;
		});
		this.#persist();
	}

	/** 聚焦第 N 个面板(⌘1..9)。返回该面板 id,没有则 undefined。 */
	panelAt(index: number): DockPanelState | undefined {
		return this.panels[index];
	}
}

export const layout = new WorkspaceLayout();
