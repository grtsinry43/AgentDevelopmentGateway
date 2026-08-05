import type {
	WorkspaceDirectoryResponse,
	WorkspaceFileContentResponse,
	WorkspaceFileCreateRequest,
	WorkspaceFileKind,
	WorkspaceFileMoveRequest
} from '@agent-gateway/shared';
import type { PushEvent } from '$contract/bridge';
import { desktop } from '$lib/shared/bridge/desktop';
import { pushBus } from '$lib/shared/bridge/events';

export const fileApi = {
	capabilities: (projectKey: string): Promise<string[]> => desktop.files.capabilities(projectKey),
	list: (projectKey: string, path: string): Promise<WorkspaceDirectoryResponse> =>
		desktop.files.list(projectKey, path),
	read: (projectKey: string, path: string): Promise<WorkspaceFileContentResponse> =>
		desktop.files.read(projectKey, path),
	write: (projectKey: string, path: string, content: string): Promise<void> =>
		desktop.files.write(projectKey, path, content),
	create: (projectKey: string, input: WorkspaceFileCreateRequest): Promise<void> =>
		desktop.files.create(projectKey, input),
	rename: (projectKey: string, input: WorkspaceFileMoveRequest): Promise<void> =>
		desktop.files.rename(projectKey, input),
	delete: (projectKey: string, path: string): Promise<void> =>
		desktop.files.delete(projectKey, path),
	copy: (projectKey: string, input: WorkspaceFileMoveRequest): Promise<void> =>
		desktop.files.copy(projectKey, input),
	copyPath: (projectKey: string, path: string, mode: 'absolute' | 'relative'): Promise<void> =>
		desktop.files.copyPath(projectKey, path, mode),
	reveal: (projectKey: string, path: string, kind: WorkspaceFileKind): Promise<string | null> =>
		desktop.files.reveal(projectKey, path, kind),
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
