/**
 * Lightweight read-only file preview state for the right dock.
 * Not an editor — open a path, show text, close.
 */

import { requireProjectKey } from '$lib/shared/bridge/desktop';
import { layout } from '$lib/features/workspace/layout.svelte';
import { fileApi } from './api';

export type FilePreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface FilePreviewRange {
	line?: number;
	startLine?: number;
	endLine?: number;
}

class FilePreviewStore {
	path = $state<string | null>(null);
	content = $state('');
	status = $state<FilePreviewStatus>('idle');
	error = $state<string | null>(null);
	/** 打开时携带的行号区间(定位/高亮用)。 */
	range = $state<FilePreviewRange | null>(null);
	editing = $state(false);
	draft = $state('');
	saving = $state(false);
	saveError = $state<string | null>(null);
	/** 预览面板读/写能力。 */
	canWrite = $state(false);
	#requestId = 0;

	async open(path: string, range?: FilePreviewRange): Promise<void> {
		const normalized = path.trim();
		if (!normalized) return;

		layout.ensurePanel('preview');
		const requestId = ++this.#requestId;
		this.path = normalized;
		this.content = '';
		this.error = null;
		this.status = 'loading';
		this.range = range ?? null;
		this.editing = false;
		this.draft = '';
		this.saveError = null;

		try {
			const [result, capabilities] = await Promise.all([
				fileApi.read(requireProjectKey(), normalized),
				fileApi.capabilities(requireProjectKey())
			]);
			if (requestId !== this.#requestId) return;
			this.path = result.path;
			this.content = result.content;
			this.status = 'ready';
			this.error = null;
			this.canWrite = capabilities.includes('workspace.files.write');
		} catch (error) {
			if (requestId !== this.#requestId) return;
			this.content = '';
			this.status = 'error';
			this.error = error instanceof Error ? error.message : '无法读取文件';
		}
	}

	/** 启用编辑:复制当前内容到草稿。 */
	startEditing(): void {
		if (this.status !== 'ready') return;
		this.draft = this.content;
		this.saveError = null;
		this.editing = true;
	}

	cancelEditing(): void {
		this.editing = false;
		this.draft = '';
		this.saveError = null;
	}

	/** 保存草稿并回到只读视图。写回成功后文件树会经 watch 失效自动刷新。 */
	async save(): Promise<boolean> {
		const targetPath = this.path;
		if (!targetPath || this.saving) return false;
		this.saving = true;
		this.saveError = null;
		try {
			await fileApi.write(requireProjectKey(), targetPath, this.draft);
			if (targetPath === this.path) {
				this.content = this.draft;
				this.editing = false;
				this.draft = '';
			}
			return true;
		} catch (error) {
			this.saveError = error instanceof Error ? error.message : '保存失败';
			return false;
		} finally {
			this.saving = false;
		}
	}

	clear(): void {
		this.#requestId += 1;
		this.path = null;
		this.content = '';
		this.status = 'idle';
		this.error = null;
		this.range = null;
		this.editing = false;
		this.draft = '';
		this.saveError = null;
		layout.removePanelsByType('preview');
	}
}

export const filePreview = new FilePreviewStore();
