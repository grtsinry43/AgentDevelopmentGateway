/**
 * remote feature 的数据访问层。所有 IPC 调用集中在这里。
 */

import type { HostDirectoryResponse } from '@agent-gateway/shared';
import { desktop } from '$lib/shared/bridge/desktop';
import type { HostProbeResult, RemoteStatus } from '$contract/bridge';

export function fetchRemoteStatus(projectKey: string): Promise<RemoteStatus> {
	return desktop.remote.status(projectKey);
}

export function reconnectRemote(projectKey: string): Promise<void> {
	return desktop.remote.reconnect(projectKey);
}

export function disconnectRemote(projectKey: string): Promise<void> {
	return desktop.remote.disconnect(projectKey);
}

export function probeHosts(): Promise<HostProbeResult[]> {
	return desktop.remote.probeHosts();
}

export function stopServer(hostProfileId: string): Promise<void> {
	return desktop.remote.stopServer(hostProfileId);
}

export function browseDirectory(
	hostProfileId: string,
	path: string
): Promise<HostDirectoryResponse> {
	return desktop.remote.browseDirectory(hostProfileId, path);
}
