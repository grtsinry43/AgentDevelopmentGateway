/**
 * 面板注册。在窗口根组件挂载前调用一次。
 *
 * 这里是 PANEL_REGISTRY 的**唯一**填充点 —— 加面板只改这个文件,DockStack 不动。
 * `requiresFeature` 让面板按 runtime capability 自动出现/隐藏,而不是按 adapter 名
 * 硬编码分支(AGENTS.md 硬规则)。
 */

import { registerPanel } from '$lib/shared/registry/panels';
import ChangesPanel from './panels/ChangesPanel.svelte';
import PortsPanel from './panels/PortsPanel.svelte';
import TasksPanel from './panels/TasksPanel.svelte';
import TerminalPanel from './panels/TerminalPanel.svelte';

let registered = false;

export function registerWorkspacePanels(): void {
	if (registered) return;
	registered = true;

	registerPanel({
		type: 'tasks',
		title: '任务',
		icon: 'list',
		component: TasksPanel,
		// 只有声明支持 todo 的 runtime 才显示这个面板
		requiresFeature: 'task.todo'
	});

	registerPanel({
		type: 'changes',
		title: '变更',
		icon: 'file-text',
		component: ChangesPanel
	});

	registerPanel({
		type: 'terminal',
		title: '终端',
		icon: 'terminal',
		component: TerminalPanel,
		contentOverflow: 'hidden'
		// 终端是 host 能力,与 runtime capability 无关
	});

	registerPanel({
		type: 'ports',
		title: '端口',
		icon: 'server',
		component: PortsPanel
	});
}
