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

/** Drag payload for right-tool-rail → dock split. */
export const PANEL_DRAG_MIME = 'application/x-agent-gateway-panel-type';

const DEFAULT_LAYOUT: WorkspaceLayoutState = {
	leftWidth: 236,
	rightWidth: 320,
	leftCollapsed: false,
	rightContentCollapsed: true,
	activePanelType: undefined,
	leftTab: 'sessions',
	rightPanels: []
};

const SAVE_DEBOUNCE_MS = 400;
const MAX_SPLIT_SLOTS = 2;

class WorkspaceLayout {
	leftWidth = $state(DEFAULT_LAYOUT.leftWidth);
	rightWidth = $state(DEFAULT_LAYOUT.rightWidth);
	leftCollapsed = $state(DEFAULT_LAYOUT.leftCollapsed);
	rightContentCollapsed = $state(DEFAULT_LAYOUT.rightContentCollapsed);
	activePanelType = $state<string | undefined>(DEFAULT_LAYOUT.activePanelType);
	leftTab = $state<LeftTab>('sessions');
	/** 右侧 dock 槽位（最多 2）。整体重新赋值,不做原地 mutation。 */
	panels = $state.raw<DockPanelState[]>(DEFAULT_LAYOUT.rightPanels);
	/** 布局是否已从磁盘读回。false 时不该写盘(否则会用默认值覆盖用户设置)。 */
	hydrated = $state(false);
	/** True while a rail icon drag is in progress (enables drop targets). */
	panelDragActive = $state(false);

	#timer: ReturnType<typeof setTimeout> | undefined;
	#counter = 0;

	/** Content area is visible (rail is always shown separately). */
	get rightContentOpen(): boolean {
		return !this.rightContentCollapsed && this.panels.length > 0;
	}

	beginPanelDrag(): void {
		this.panelDragActive = true;
	}

	endPanelDrag(): void {
		this.panelDragActive = false;
	}

	/** 从主进程读回布局。异步,不阻塞首帧 —— 先用默认值渲染。 */
	async load(): Promise<void> {
		try {
			const saved = await desktop.layout.get(requireProjectKey());
			if (saved) this.#apply(normalizeLayout(saved));
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
		this.rightContentCollapsed = state.rightContentCollapsed;
		this.activePanelType = state.activePanelType;
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
			rightContentCollapsed: this.rightContentCollapsed,
			activePanelType: this.activePanelType,
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

	#panelId(type: string): string {
		return `${type}-${Date.now().toString(36)}-${this.#counter++}`;
	}

	#slot(type: string, weight = 1): DockPanelState {
		return { id: this.#panelId(type), type, weight, collapsed: false };
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

	/** Toggle right content visibility (rail stays). */
	toggleRight(): void {
		if (this.rightContentOpen) {
			this.rightContentCollapsed = true;
		} else if (this.panels.length > 0) {
			this.rightContentCollapsed = false;
		} else {
			// Nothing open — leave collapsed; caller should activate a panel type.
			this.rightContentCollapsed = true;
		}
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

	/**
	 * Rail click: active type while content open → collapse; otherwise open as single tab.
	 */
	activatePanel(type: string): void {
		const isActive =
			this.rightContentOpen &&
			this.activePanelType === type &&
			this.panels.some((panel) => panel.type === type);

		if (isActive) {
			this.rightContentCollapsed = true;
			this.#persist();
			return;
		}

		this.panels = [this.#slot(type)];
		this.activePanelType = type;
		this.rightContentCollapsed = false;
		this.#persist();
	}

	/**
	 * Ensure `type` is visible. Prefer keeping a split if the type is already a slot;
	 * otherwise open as a single tab (exits split).
	 */
	ensurePanel(type: string): string {
		const existing = this.panels.find((panel) => panel.type === type);
		if (existing) {
			this.panels = this.panels.map((panel) =>
				panel.id === existing.id ? { ...panel, collapsed: false } : panel
			);
			this.activePanelType = type;
			this.rightContentCollapsed = false;
			this.#persist();
			return existing.id;
		}

		const slot = this.#slot(type);
		this.panels = [slot];
		this.activePanelType = type;
		this.rightContentCollapsed = false;
		this.#persist();
		return slot.id;
	}

	/**
	 * Drop a panel type onto the top or bottom half of the content area (max 2 slots).
	 */
	splitPanel(type: string, region: 'top' | 'bottom'): void {
		const other = this.panels.find((panel) => panel.type !== type);
		const primary = this.#slot(type, 1);
		if (!other) {
			// Empty or only this type — stay single unless we had another type.
			const current = this.panels[0];
			if (!current || current.type === type) {
				this.panels = [primary];
			} else {
				this.panels =
					region === 'top'
						? [primary, { ...current, weight: 1, collapsed: false }]
						: [{ ...current, weight: 1, collapsed: false }, primary];
			}
		} else {
			const kept = { ...other, weight: 1, collapsed: false };
			this.panels = region === 'top' ? [primary, kept] : [kept, primary];
		}
		// Cap at 2 and unique types
		this.panels = dedupePanels(this.panels).slice(0, MAX_SPLIT_SLOTS);
		this.activePanelType = type;
		this.rightContentCollapsed = false;
		this.#persist();
	}

	/** Remove every dock panel with the given registry type. */
	removePanelsByType(type: string): void {
		const next = this.panels.filter((panel) => panel.type !== type);
		if (next.length === this.panels.length) return;
		this.panels = next;
		if (this.activePanelType === type) {
			this.activePanelType = next[0]?.type;
		}
		if (next.length === 0) this.rightContentCollapsed = true;
		this.#persist();
	}

	removePanel(id: string): void {
		const removed = this.panels.find((panel) => panel.id === id);
		const next = this.panels.filter((panel) => panel.id !== id);
		this.panels = next;
		if (removed && this.activePanelType === removed.type) {
			this.activePanelType = next[0]?.type;
		}
		if (next.length === 0) this.rightContentCollapsed = true;
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

	isPanelActive(type: string): boolean {
		return (
			this.rightContentOpen &&
			this.activePanelType === type &&
			this.panels.some((panel) => panel.type === type)
		);
	}

	isPanelOpen(type: string): boolean {
		return this.panels.some((panel) => panel.type === type);
	}
}

/** Normalize persisted / legacy layout into the JetBrains dock shape. */
export function normalizeLayout(raw: WorkspaceLayoutState): WorkspaceLayoutState {
	const panels = dedupePanels(raw.rightPanels ?? []).slice(0, MAX_SPLIT_SLOTS);
	const rightContentCollapsed =
		raw.rightContentCollapsed ??
		raw.rightCollapsed ??
		panels.length === 0;
	const activePanelType =
		raw.activePanelType && panels.some((panel) => panel.type === raw.activePanelType)
			? raw.activePanelType
			: panels[0]?.type;

	return {
		leftWidth: raw.leftWidth,
		rightWidth: raw.rightWidth,
		leftCollapsed: raw.leftCollapsed,
		rightContentCollapsed,
		activePanelType,
		leftTab: raw.leftTab,
		rightPanels: panels.map((panel) => ({ ...panel, collapsed: panel.collapsed ?? false }))
	};
}

function dedupePanels(panels: DockPanelState[]): DockPanelState[] {
	const seen: Record<string, true> = {};
	const result: DockPanelState[] = [];
	for (const panel of panels) {
		if (seen[panel.type]) continue;
		seen[panel.type] = true;
		result.push(panel);
	}
	return result;
}

export const layout = new WorkspaceLayout();
