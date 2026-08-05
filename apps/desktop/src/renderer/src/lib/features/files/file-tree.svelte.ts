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
	/** 文件剪贴板:复制/剪切的源节点。`cut` 为 true 表示粘贴时移动而非复制。 */
	clipboard = $state<{ path: string; cut: boolean } | undefined>(undefined);
	private generation = 0;

	constructor(readonly projectKey: string) {}

	get supported(): boolean {
		return (
			this.capabilities.includes('workspace.files.list') &&
			this.capabilities.includes('workspace.files.watch')
		);
	}

	get canWrite(): boolean {
		return (
			this.capabilities.includes('workspace.files.create') &&
			this.capabilities.includes('workspace.files.rename') &&
			this.capabilities.includes('workspace.files.delete')
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

	/** 新建文件/目录;成功后刷新父目录并选中新节点。 */
	async createEntry(parentPath: string, name: string, kind: 'file' | 'directory'): Promise<void> {
		const path = parentPath ? `${parentPath}/${name}` : name;
		await fileApi.create(this.projectKey, { path, kind });
		await this.refreshDirectories([parentPath], this.generation);
		this.select(path);
	}

	/** 重命名/移动(路径可带目录前缀);成功后刷新新旧父目录。 */
	async renameEntry(node: FileTreeNode, newPath: string): Promise<void> {
		if (newPath === node.path) return;
		await fileApi.rename(this.projectKey, { from: node.path, to: newPath });
		const parents = unique([parentOf(node.path), parentOf(newPath)]);
		await this.refreshDirectories(parents, this.generation);
		this.select(newPath);
	}

	async deleteEntry(node: FileTreeNode): Promise<void> {
		await fileApi.delete(this.projectKey, node.path);
		await this.refreshDirectories([parentOf(node.path)], this.generation);
		if (this.selectedPath === node.path) this.select(undefined);
	}

	/** 拖拽移动:把节点移入目标目录(同一目录为 no-op)。 */
	async moveEntry(node: FileTreeNode, targetDirectory: string): Promise<void> {
		const sourceParent = parentOf(node.path);
		if (sourceParent === targetDirectory) return;
		const to = targetDirectory ? `${targetDirectory}/${node.name}` : node.name;
		await fileApi.rename(this.projectKey, { from: node.path, to });
		await this.refreshDirectories(unique([sourceParent, targetDirectory]), this.generation);
		this.select(to);
	}

	copyNode(node: FileTreeNode): void {
		this.clipboard = { path: node.path, cut: false };
	}

	cutNode(node: FileTreeNode): void {
		this.clipboard = { path: node.path, cut: true };
	}

	/** 复制工作区相对/绝对路径到系统剪贴板。 */
	async copyPathText(node: FileTreeNode, mode: 'absolute' | 'relative'): Promise<void> {
		await fileApi.copyPath(this.projectKey, node.path, mode);
	}

	/**
	 * 把剪贴板里的节点粘贴到目标目录。返回新路径;复制保留剪贴板,剪切粘贴后清空。
	 * 目标同名时自动生成 `name copy` / `name copy 2` 副本名。
	 */
	async pasteInto(targetDirectory: string): Promise<string | undefined> {
		const source = this.clipboard;
		if (!source) return undefined;
		const sourceParent = parentOf(source.path);
		if (source.cut && sourceParent === targetDirectory) return undefined;
		const baseName = basenameOf(source.path);
		const target = await this.availableName(targetDirectory, baseName);
		if (source.cut) {
			await fileApi.rename(this.projectKey, { from: source.path, to: target });
			this.clipboard = undefined;
		} else {
			await fileApi.copy(this.projectKey, { from: source.path, to: target });
		}
		await this.refreshDirectories(unique([sourceParent, targetDirectory]), this.generation);
		this.select(target);
		return target;
	}

	/** 目标目录里生成不冲突的副本名:`foo.txt` → `foo copy.txt` / `foo copy 2.txt`。 */
	private async availableName(directory: string, baseName: string): Promise<string> {
		const response = await fileApi.list(this.projectKey, directory);
		const existing: Record<string, boolean> = {};
		for (const entry of response.entries) existing[entry.name] = true;
		if (!existing[baseName]) {
			return directory ? `${directory}/${baseName}` : baseName;
		}
		const dot = baseName.lastIndexOf('.');
		const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
		const ext = dot > 0 ? baseName.slice(dot) : '';
		for (let index = 1; ; index += 1) {
			const candidate = index === 1 ? `${stem} copy${ext}` : `${stem} copy ${index}${ext}`;
			if (!existing[candidate]) {
				return directory ? `${directory}/${candidate}` : candidate;
			}
		}
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

function parentOf(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

function basenameOf(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? path : path.slice(index + 1);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
