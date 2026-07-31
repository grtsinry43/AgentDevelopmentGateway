/**
 * project feature 的数据访问层。
 *
 * 所有 IPC 调用集中在这里,组件不直接碰 `desktop.projects.*` —— 与 grtblog 的
 * `features/<feature>/api.ts` 约定一致。将来换传输(Web 客户端走 HTTP)只改这个文件。
 */

import { desktop } from '$lib/shared/bridge/desktop';
import { basename } from '$lib/shared/utils/path';
import type { NewProjectInput, ProjectDraft, RecentProject } from './types';

export function listRecentProjects(): Promise<RecentProject[]> {
	return desktop.projects.list();
}

/** 打开原生目录选择器。用户取消返回 null。 */
export function pickDirectory(): Promise<string | null> {
	return desktop.projects.pickDirectory();
}

export function addProject(input: NewProjectInput): Promise<RecentProject> {
	return desktop.projects.add(input);
}

export function removeProject(key: string): Promise<void> {
	return desktop.projects.remove(key);
}

export function togglePinProject(key: string): Promise<void> {
	return desktop.projects.togglePin(key);
}

/** 打开工程窗口。主进程会顺带关掉 Launcher。 */
export function openProject(key: string): Promise<void> {
	return desktop.projects.open(key);
}

/** 草稿 → IPC 入参。名称留空时用路径末段兜底,避免出现无名工程。 */
export function draftToInput(draft: ProjectDraft): NewProjectInput {
	const path = draft.path.trim().replace(/[/\\]+$/, '');
	return {
		name: draft.name.trim() || basename(path) || path,
		hostId: draft.hostType === 'local' ? 'local' : draft.hostId.trim(),
		hostType: draft.hostType,
		path
	};
}

/** 草稿是否可提交。远程工程必须填 host 别名,否则无法定位机器。 */
export function isDraftValid(draft: ProjectDraft): boolean {
	if (!draft.path.trim()) return false;
	if (draft.hostType === 'ssh' && !draft.hostId.trim()) return false;
	return true;
}
