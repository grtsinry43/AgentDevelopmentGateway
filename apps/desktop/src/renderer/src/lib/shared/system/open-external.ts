import { desktop } from '$lib/shared/bridge/desktop';

/** Open a web URL through the main process instead of navigating the project window. */
export function openExternalUrl(url: string): Promise<void> {
	return desktop.system.openExternal(url);
}
