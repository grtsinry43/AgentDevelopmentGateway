import type { WorkspaceFileNode } from '@agent-gateway/shared';
import { fileApi } from './api';

export interface FileTreeNode extends WorkspaceFileNode {
	children?: FileTreeNode[];
}

type FileTreeStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
type FileStreamState = 'closed' | 'connecting' | 'connected' | 'retrying' | 'error';

export class FileTreeWorkspace {
	status = $state<FileTreeStatus>('idle');
	streamState = $state<FileStreamState>('closed');
	error = $state<string | undefined>();
	streamMessage = $state<string | undefined>();
	capabilities = $state.raw<string[]>([]);
	selectedPath = $state<string | undefined>();
	private directories = $state.raw<Record<string, WorkspaceFileNode[]>>({});
	private expandedDirectories: string[] = [];
	private generation = 0;

	constructor(readonly projectKey: string) {}

	get supported(): boolean {
		return (
			this.capabilities.includes('workspace.files.list') &&
			this.capabilities.includes('workspace.files.watch')
		);
	}

	get rootNode(): FileTreeNode {
		return {
			name: '',
			path: '__workspace_root__',
			kind: 'directory',
			generated: false,
			children: this.buildChildren('')
		};
	}

	start(): () => void {
		const generation = ++this.generation;
		const unsubscribe = [
			fileApi.onInvalidated((event) => {
				if (event.projectKey !== this.projectKey) return;
				void this.refreshDirectories(event.paths, generation);
			}),
			fileApi.onResync((event) => {
				if (event.projectKey !== this.projectKey) return;
				void this.refreshDirectories(Object.keys(this.directories), generation);
			}),
			fileApi.onStream((event) => {
				if (event.projectKey !== this.projectKey) return;
				this.streamState = event.state;
				this.streamMessage = event.message;
			})
		];
		void this.initialize(generation);

		return () => {
			if (this.generation === generation) this.generation += 1;
			for (const stop of unsubscribe) stop();
			void fileApi.unwatch(this.projectKey);
			this.streamState = 'closed';
		};
	}

	async loadChildren(node: FileTreeNode, signal?: AbortSignal): Promise<FileTreeNode[]> {
		if (node.kind !== 'directory') return [];
		const response = await fileApi.list(this.projectKey, node.path);
		if (signal?.aborted) return [];
		this.replaceDirectory(response.path, response.entries);
		return this.buildChildren(response.path);
	}

	select(path: string | undefined): void {
		this.selectedPath = path;
	}

	async setExpanded(nodes: FileTreeNode[]): Promise<void> {
		this.expandedDirectories = nodes
			.filter((node) => node.kind === 'directory')
			.map((node) => node.path)
			.filter((path, index, paths) => paths.indexOf(path) === index);
		try {
			await fileApi.updateWatch(this.projectKey, this.expandedDirectories);
		} catch (error) {
			this.error = errorMessage(error);
		}
	}

	async retry(): Promise<void> {
		try {
			this.error = undefined;
			if (this.status === 'error') {
				this.status = 'loading';
				await this.loadRoot(this.generation);
				this.status = 'ready';
			}
			await fileApi.retry(this.projectKey);
		} catch (error) {
			this.error = errorMessage(error);
		}
	}

	async refresh(): Promise<void> {
		await this.refreshDirectories(Object.keys(this.directories), this.generation);
	}

	private async initialize(generation: number): Promise<void> {
		this.status = 'loading';
		this.error = undefined;
		try {
			this.capabilities = await fileApi.capabilities(this.projectKey);
			if (generation !== this.generation) return;
			if (!this.supported) {
				this.status = 'unavailable';
				return;
			}
			await Promise.all([this.loadRoot(generation), fileApi.watch(this.projectKey, [])]);
			if (generation === this.generation) this.status = 'ready';
		} catch (error) {
			if (generation !== this.generation) return;
			this.status = 'error';
			this.error = errorMessage(error);
		}
	}

	private async loadRoot(generation: number): Promise<void> {
		const response = await fileApi.list(this.projectKey, '');
		if (generation !== this.generation) return;
		this.replaceDirectory(response.path, response.entries);
	}

	private async refreshDirectories(paths: string[], generation: number): Promise<void> {
		const loaded = paths
			.filter((path, index) => paths.indexOf(path) === index)
			.filter((path) => Object.hasOwn(this.directories, path));
		if (loaded.length === 0) return;
		try {
			const responses = await Promise.allSettled(
				loaded.map(async (path) => ({ path, response: await fileApi.list(this.projectKey, path) }))
			);
			if (generation !== this.generation) return;
			const next = { ...this.directories };
			let firstError: unknown;
			for (const result of responses) {
				if (result.status === 'fulfilled') {
					next[result.value.response.path] = result.value.response.entries;
				} else {
					const failedPath = loaded[responses.indexOf(result)];
					if (failedPath) delete next[failedPath];
					firstError ??= result.reason;
				}
			}
			this.directories = next;
			this.error = firstError === undefined ? undefined : errorMessage(firstError);
		} catch (error) {
			if (generation !== this.generation) return;
			this.error = errorMessage(error);
		}
	}

	private replaceDirectory(path: string, entries: WorkspaceFileNode[]): void {
		this.directories = { ...this.directories, [path]: entries };
	}

	private buildChildren(path: string): FileTreeNode[] {
		return (this.directories[path] ?? []).map((node) => ({
			...node,
			...(node.kind === 'directory'
				? {
						children: Object.hasOwn(this.directories, node.path)
							? this.buildChildren(node.path)
							: []
					}
				: {})
		}));
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : '文件树操作失败';
}
