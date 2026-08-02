<script lang="ts">
	/**
	 * 远程 server 日志面板(工程窗口右侧 dock,仅远程工程)。
	 * 串流按 hostProfileId 启动/停止,渲染交给 RemoteLogView。
	 */
	import { onMount } from 'svelte';
	import { remoteLog } from '../log-store.svelte';
	import { remoteConnection } from '../remote.svelte';
	import RemoteLogView from './RemoteLogView.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	// hostProfileId 异步就绪后才开始串流(remoteConnection.status 是异步拉的)。
	$effect(() => {
		const profileId = remoteConnection.status?.hostProfileId;
		if (profileId) void remoteLog.start(profileId);
	});

	onMount(() => {
		const unwatch = remoteLog.watch();
		return () => {
			unwatch();
			void remoteLog.stop();
		};
	});
</script>

<div class="flex h-full flex-col overflow-hidden">
	<div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-subtle px-2">
		<Icon name="log" size={11} class="text-faint" />
		<span class="text-2xs text-muted">远程 Server 日志</span>
	</div>
	<div class="min-h-0 flex-1 px-2 py-1">
		<RemoteLogView />
	</div>
</div>
