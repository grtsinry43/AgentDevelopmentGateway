import type {
	GitChangeArea,
	GitCommitResponse,
	GitDiffResponse,
	GitRepositoryState
} from '@agent-gateway/shared';
import type { GitStatusResult, PushEvent } from '$contract/bridge';
import { desktop } from '$lib/shared/bridge/desktop';
import { pushBus } from '$lib/shared/bridge/events';

export const gitApi = {
	capabilities: (projectKey: string): Promise<string[]> => desktop.git.capabilities(projectKey),
	status: (projectKey: string): Promise<GitStatusResult> => desktop.git.status(projectKey),
	diff: (projectKey: string, path: string, area: GitChangeArea): Promise<GitDiffResponse> =>
		desktop.git.diff(projectKey, path, area),
	stage: (projectKey: string, paths: string[]): Promise<void> =>
		desktop.git.stage(projectKey, paths),
	unstage: (projectKey: string, paths: string[]): Promise<void> =>
		desktop.git.unstage(projectKey, paths),
	commit: (projectKey: string, message: string): Promise<GitCommitResponse> =>
		desktop.git.commit(projectKey, message),
	watch: (projectKey: string): Promise<void> => desktop.git.watch(projectKey),
	unwatch: (projectKey: string): Promise<void> => desktop.git.unwatch(projectKey),
	retry: (projectKey: string): Promise<void> => desktop.git.retry(projectKey),
	onInvalidated: (
		handler: (event: Extract<PushEvent, { kind: 'git.invalidated' }>) => void
	): (() => void) => pushBus.on('git.invalidated', handler),
	onStream: (handler: (event: Extract<PushEvent, { kind: 'git.stream' }>) => void): (() => void) =>
		pushBus.on('git.stream', handler)
};

export type { GitCommitResponse, GitRepositoryState };
