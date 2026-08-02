/**
 * project feature 的数据访问层。
 *
 * 所有 IPC 调用集中在这里,组件不直接碰 `desktop.projects.*` / `desktop.hosts.*` ——
 * 与 grtblog 的 `features/<feature>/api.ts` 约定一致。将来换传输(Web 客户端走 HTTP)
 * 只改这个文件。
 */

import { desktop } from '$lib/shared/bridge/desktop';
import { basename } from '$lib/shared/utils/path';
import type {
	HostDraft,
	HostProfile,
	HostProfileInput,
	ProjectDraft,
	RecentProject
} from './types';

export function listRecentProjects(): Promise<RecentProject[]> {
	return desktop.projects.list();
}

/** 打开原生目录选择器。用户取消返回 null。 */
export function pickDirectory(): Promise<string | null> {
	return desktop.projects.pickDirectory();
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

// ── SSH 主机 ──────────────────────────────────────────────────────────────

export function listHosts(): Promise<HostProfile[]> {
	return desktop.hosts.list();
}

export function saveHost(input: HostProfileInput): Promise<HostProfile> {
	return desktop.hosts.save(input);
}

export function removeHost(id: string): Promise<void> {
	return desktop.hosts.remove(id);
}

export function pickKeyFile(): Promise<string | null> {
	return desktop.hosts.pickKeyFile();
}

// ── 草稿 → 提交 ───────────────────────────────────────────────────────────

/** 主机草稿 → 保存主机的入参。 */
export function hostDraftToInput(draft: HostDraft, id?: string): HostProfileInput {
	const username = draft.username.trim();
	const hostname = draft.hostname.trim();
	return {
		...(id ? { id } : {}),
		name: draft.name.trim() || `${username}@${hostname}`,
		username,
		hostname,
		port: Number(draft.port.trim()) || 22,
		auth: draft.auth,
		...(draft.auth === 'key' ? { keyPath: draft.keyPath.trim() } : {}),
		...(draft.auth === 'password' && draft.password ? { password: draft.password } : {}),
		rememberPassword: draft.rememberPassword
	};
}

/**
 * 草稿 → 建工程。ssh + 'new' 主机时先保存主机拿到 profileId,再建工程 ——
 * 两步都在主进程/存储层完成,这里只做编排。
 */
export async function createProjectFromDraft(draft: ProjectDraft): Promise<RecentProject> {
	const path = draft.path.trim().replace(/[/\\]+$/, '');
	const name = draft.name.trim() || basename(path) || path;

	if (draft.hostType === 'local') {
		return desktop.projects.add({ name, hostId: 'local', hostType: 'local', path });
	}

	let hostProfileId = draft.hostProfileId;
	if (hostProfileId === 'new') {
		const saved = await saveHost(hostDraftToInput(draft.host));
		hostProfileId = saved.id;
	}
	return desktop.projects.add({ name, hostId: '', hostType: 'ssh', path, hostProfileId });
}

/** 主机草稿是否可保存。 */
export function isHostDraftValid(draft: HostDraft): boolean {
	if (!draft.username.trim() || !draft.hostname.trim()) return false;
	const port = Number(draft.port.trim() || '22');
	if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	if (draft.auth === 'key') return Boolean(draft.keyPath.trim());
	return Boolean(draft.password);
}

/** 草稿是否可提交。 */
export function isDraftValid(draft: ProjectDraft): boolean {
	if (!draft.path.trim()) return false;
	if (draft.hostType === 'local') return true;
	if (draft.hostProfileId === 'new') return isHostDraftValid(draft.host);
	return Boolean(draft.hostProfileId);
}
