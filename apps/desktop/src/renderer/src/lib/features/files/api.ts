import type { WorkspaceDirectoryResponse } from '@agent-gateway/shared';
import type { PushEvent } from '$contract/bridge';
import { desktop } from '$lib/shared/bridge/desktop';
import { pushBus } from '$lib/shared/bridge/events';

export const fileApi = {
	capabilities: (projectKey: string): Promise<string[]> => desktop.files.capabilities(projectKey),
	list: (projectKey: string, path: string): Promise<WorkspaceDirectoryResponse> =>
		desktop.files.list(projectKey, path),
	watch: (projectKey: string, directories: string[]): Promise<void> =>
		desktop.files.watch(projectKey, directories),
	updateWatch: (projectKey: string, directories: string[]): Promise<void> =>
		desktop.files.updateWatch(projectKey, directories),
	unwatch: (projectKey: string): Promise<void> => desktop.files.unwatch(projectKey),
	retry: (projectKey: string): Promise<void> => desktop.files.retry(projectKey),
	onInvalidated: (
		handler: (event: Extract<PushEvent, { kind: 'files.invalidated' }>) => void
	): (() => void) => pushBus.on('files.invalidated', handler),
	onResync: (
		handler: (event: Extract<PushEvent, { kind: 'files.resync' }>) => void
	): (() => void) => pushBus.on('files.resync', handler),
	onStream: (
		handler: (event: Extract<PushEvent, { kind: 'files.stream' }>) => void
	): (() => void) => pushBus.on('files.stream', handler)
};
