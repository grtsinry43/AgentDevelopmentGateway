/**
 * Lightweight read-only file preview state for the right dock.
 * Not an editor — open a path, show text, close.
 */

import { requireProjectKey } from '$lib/shared/bridge/desktop';
import { layout } from '$lib/features/workspace/layout.svelte';
import { fileApi } from './api';

export type FilePreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

class FilePreviewStore {
	path = $state<string | null>(null);
	content = $state('');
	status = $state<FilePreviewStatus>('idle');
	error = $state<string | null>(null);
	#requestId = 0;

	async open(path: string): Promise<void> {
		const normalized = path.trim();
		if (!normalized) return;

		layout.ensurePanel('preview');
		const requestId = ++this.#requestId;
		this.path = normalized;
		this.content = '';
		this.error = null;
		this.status = 'loading';

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
		layout.removePanelsByType('preview');
	}
}

export const filePreview = new FilePreviewStore();
