import type { GitChange, GitCommitResponse, GitRepositoryState } from '@agent-gateway/shared';
import type { FileDiffChange } from '$lib/ui/diff/FileDiff.svelte';
import { gitApi } from './api';

type GitWorkspaceStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
type GitStreamState = 'closed' | 'connecting' | 'connected' | 'retrying' | 'error';

const REQUIRED_CAPABILITIES = [
	'workspace.git.status',
	'workspace.git.diff',
	'workspace.git.stage',
	'workspace.git.unstage',
	'workspace.git.commit',
	'workspace.git.watch'
] as const;

export class GitWorkspace {
	status = $state<GitWorkspaceStatus>('idle');
	streamState = $state<GitStreamState>('closed');
	state = $state.raw<GitRepositoryState>();
	capabilities = $state.raw<string[]>([]);
	error = $state<string | undefined>();
	unavailableMessage = $state<string | undefined>();
	streamMessage = $state<string | undefined>();
	activeOperation = $state<string | undefined>();
	selectedChangeKey = $state<string | undefined>();
	selectedDiff = $state.raw<FileDiffChange>();
	diffLoading = $state(false);
	private generation = 0;
	private diffGeneration = 0;
	private refreshTask: Promise<void> | undefined;
	private refreshQueued = false;

	constructor(readonly projectKey: string) {}

	get supported(): boolean {
		return REQUIRED_CAPABILITIES.every((capability) => this.capabilities.includes(capability));
	}

	start(): () => void {
		const generation = ++this.generation;
		const unsubscribe = [
			gitApi.onInvalidated((event) => {
				if (event.projectKey !== this.projectKey) return;
				this.invalidateDiff();
				void this.refresh(generation);
			}),
			gitApi.onStream((event) => {
				if (event.projectKey !== this.projectKey) return;
				this.streamState = event.state;
				this.streamMessage = event.message;
			})
		];
		void this.initialize(generation);

		return () => {
			if (this.generation === generation) this.generation += 1;
			this.diffGeneration += 1;
			for (const stop of unsubscribe) stop();
			void gitApi.unwatch(this.projectKey);
			this.streamState = 'closed';
		};
	}

	async refresh(generation = this.generation): Promise<void> {
		if (this.refreshTask) {
			this.refreshQueued = true;
			return this.refreshTask;
		}
		this.refreshTask = this.loadStatus(generation)
			.then(() => undefined)
			.finally(() => {
				this.refreshTask = undefined;
				if (this.refreshQueued && generation === this.generation) {
					this.refreshQueued = false;
					void this.refresh(generation);
				}
			});
		return this.refreshTask;
	}

	async retry(): Promise<void> {
		this.error = undefined;
		if (this.status === 'error') {
			this.status = 'loading';
			await this.initialize(this.generation);
			return;
		}
		try {
			await gitApi.retry(this.projectKey);
		} catch (error) {
			this.error = errorMessage(error);
		}
	}

	async toggleDiff(change: GitChange): Promise<void> {
		const key = changeKey(change);
		if (this.selectedChangeKey === key) {
			this.invalidateDiff();
			return;
		}
		const generation = ++this.diffGeneration;
		this.selectedChangeKey = key;
		this.selectedDiff = undefined;
		this.diffLoading = true;
		try {
			const response = await gitApi.diff(this.projectKey, change.path, change.area);
			if (generation !== this.diffGeneration) return;
			this.selectedDiff = response.change;
		} catch (error) {
			if (generation !== this.diffGeneration) return;
			this.error = errorMessage(error);
		} finally {
			if (generation === this.diffGeneration) this.diffLoading = false;
		}
	}

	stage(paths: string[]): Promise<boolean> {
		return this.runMutation('stage', () => gitApi.stage(this.projectKey, paths));
	}

	unstage(paths: string[]): Promise<boolean> {
		return this.runMutation('unstage', () => gitApi.unstage(this.projectKey, paths));
	}

	async commit(message: string): Promise<GitCommitResponse | undefined> {
		let committed: GitCommitResponse | undefined;
		const succeeded = await this.runMutation('commit', async () => {
			committed = await gitApi.commit(this.projectKey, message);
		});
		return succeeded ? committed : undefined;
	}

	private async initialize(generation: number): Promise<void> {
		this.status = 'loading';
		this.error = undefined;
		this.unavailableMessage = undefined;
		try {
			this.capabilities = await gitApi.capabilities(this.projectKey);
			if (generation !== this.generation) return;
			if (!this.supported) {
				this.status = 'unavailable';
				this.unavailableMessage = '当前 Gateway Server 未提供完整的 Git 工作区能力。';
				return;
			}
			const ready = await this.loadStatus(generation);
			if (generation !== this.generation || !ready) return;
			await gitApi.watch(this.projectKey);
		} catch (error) {
			if (generation !== this.generation) return;
			this.status = 'error';
			this.error = errorMessage(error);
		}
	}

	private async loadStatus(generation: number): Promise<boolean> {
		try {
			const result = await gitApi.status(this.projectKey);
			if (generation !== this.generation) return false;
			if (!result.available) {
				this.state = undefined;
				this.status = 'unavailable';
				this.unavailableMessage = result.message;
				return false;
			}
			this.state = result.state;
			this.status = 'ready';
			this.error = undefined;
			return true;
		} catch (error) {
			if (generation !== this.generation) return false;
			this.status = 'error';
			this.error = errorMessage(error);
			return false;
		}
	}

	private async runMutation(operation: string, run: () => Promise<void>): Promise<boolean> {
		if (this.activeOperation) return false;
		this.activeOperation = operation;
		this.error = undefined;
		try {
			await run();
			this.invalidateDiff();
			await this.refresh();
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			return false;
		} finally {
			this.activeOperation = undefined;
		}
	}

	private invalidateDiff(): void {
		this.diffGeneration += 1;
		this.selectedChangeKey = undefined;
		this.selectedDiff = undefined;
		this.diffLoading = false;
	}
}

export function changeKey(change: GitChange): string {
	return `${change.area}\0${change.path}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Git 操作失败';
}
