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

		try {
			const result = await fileApi.read(requireProjectKey(), normalized);
			if (requestId !== this.#requestId) return;
			this.path = result.path;
			this.content = result.content;
			this.status = 'ready';
			this.error = null;
		} catch (error) {
			if (requestId !== this.#requestId) return;
			this.content = '';
			this.status = 'error';
			this.error = error instanceof Error ? error.message : '无法读取文件';
		}
	}

	clear(): void {
		this.#requestId += 1;
		this.path = null;
		this.content = '';
		this.status = 'idle';
		this.error = null;
		this.range = null;
		layout.removePanelsByType('preview');
	}
}

export const filePreview = new FilePreviewStore();
