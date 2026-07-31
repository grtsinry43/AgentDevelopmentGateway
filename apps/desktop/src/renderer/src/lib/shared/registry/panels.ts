/**
 * Panel 注册表。
 *
 * dock 里能放什么由这张表决定,而不是在 DockStack 里写一串 `{#if type === ...}`。
 * 加面板 = 加一条注册,布局代码不动。
 *
 * 这也是下一阶段接 adapter feature UI 的样板:`runtime.extension` 的
 * Feature Registry 会用同一个形态(需求 §9.5 要求客户端通过 Feature Registry
 * 注册专用 UI,避免散落 `if (adapterId === ...)`)。
 */

import type { Component } from 'svelte';
import type { IconName } from '$lib/ui/icons/Icon.svelte';
import type { RuntimeFeature } from '@agent-gateway/core';

export interface PanelDefinition {
	/** 持久化用的稳定 key。改名会导致已存布局失效,所以别改。 */
	type: string;
	title: string;
	icon: IconName;
	component: Component;
	/**
	 * 该面板依赖的 runtime capability。当前会话的 `RuntimeCapabilities.features`
	 * 里此项为真才可用 —— **这是能力门控的唯一机制**,禁止按 adapterId 分支
	 * (AGENTS.md 硬规则)。省略表示与 runtime 能力无关(终端、文件树)。
	 */
	requiresFeature?: RuntimeFeature;
	/** 默认高度权重。 */
	defaultWeight?: number;
}

const registry = new Map<string, PanelDefinition>();

export function registerPanel(definition: PanelDefinition): void {
	registry.set(definition.type, definition);
}

export function getPanel(type: string): PanelDefinition | undefined {
	return registry.get(type);
}

export function listPanels(): PanelDefinition[] {
	return [...registry.values()];
}

/**
 * 按 capability 过滤出当前会话可用的面板。
 * `features` 传 undefined 表示还没有活动会话 —— 此时只显示无能力依赖的面板。
 */
export function availablePanels(
	features: Partial<Record<RuntimeFeature, boolean>> | undefined
): PanelDefinition[] {
	return listPanels().filter((panel) => {
		if (!panel.requiresFeature) return true;
		return features?.[panel.requiresFeature] === true;
	});
}
