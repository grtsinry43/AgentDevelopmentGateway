<script lang="ts">
	import { requireProjectIdentity } from '$lib/shared/bridge/desktop';
	import { portsStore } from '$lib/features/workspace/ports.svelte';
	import { notifications } from '$lib/shared/notifications/notifications.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	const identity = requireProjectIdentity();
	const isRemote = identity.hostType === 'ssh';
	const hostLabel = identity.hostLabel ?? '';
	const projectKey = identity.projectKey;

	let bindPort = $state('');
	let binding = $state(false);

	// 挂载即加载本主机转发列表,并订阅主进程广播(预览/手动绑定/关闭都会推 `ports.changed`)。
	$effect(() => {
		void portsStore.load(projectKey);
		const stop = portsStore.watch();
		return () => stop();
	});

	function onPortInput(event: Event): void {
		bindPort = (event.currentTarget as HTMLInputElement).value.replace(/\D/g, '').slice(0, 5);
	}

	async function bindForward(): Promise<void> {
		const port = Number(bindPort);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			notifications.notify({
				key: 'ports-bind-invalid',
				severity: 'error',
				title: '端口无效',
				summary: '请输入 1–65535 之间的端口号'
			});
			return;
		}
		if (binding) return;
		binding = true;
		try {
			await portsStore.bind(projectKey, port);
			bindPort = '';
		} catch (error) {
			notifications.notify({
				key: `ports-bind:${port}`,
				severity: 'error',
				title: '端口绑定失败',
				summary: error instanceof Error ? error.message : String(error)
			});
		} finally {
			binding = false;
		}
	}

	async function closeForward(remotePort: number): Promise<void> {
		try {
			await portsStore.close(projectKey, remotePort);
		} catch (error) {
			notifications.notify({
				key: `ports-close:${remotePort}`,
				severity: 'error',
				title: '关闭转发失败',
				summary: error instanceof Error ? error.message : String(error)
			});
		}
	}
</script>

{#if !isRemote}
	<EmptyState
		title="本地工程"
		description="开发服务直接监听在本机 127.0.0.1,无需端口转发;Web 预览会直接打开对应端口。"
		compact
	>
		{#snippet icon()}<Icon name="server" size={16} />{/snippet}
	</EmptyState>
{:else if portsStore.loading && portsStore.forwards.length === 0}
	<div class="grid h-full place-items-center text-2xs text-faint">加载中…</div>
{:else}
	<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
		{#if portsStore.forwards.length === 0}
			<div class="min-h-0 flex-1">
				<EmptyState
					title="还没有端口转发"
					description="Agent 预览打开的端口会自动出现在这里,也可以手动绑定远端端口。"
					compact
				>
					{#snippet icon()}<Icon name="server" size={16} />{/snippet}
				</EmptyState>
			</div>
		{:else}
			<div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
				{#each portsStore.forwards as forward (forward.remotePort)}
					<div class="flex h-8 items-center gap-2 border-b border-subtle px-2.5 text-xs last:border-b-0">
						<Icon name="plug" size={12} class="shrink-0 text-faint" />
						<code class="min-w-0 flex-1 truncate font-mono text-normal">
							127.0.0.1:{forward.localPort}
						</code>
						<span class="shrink-0 text-2xs text-faint">→</span>
						<code class="shrink-0 font-mono text-2xs text-muted"
							>{hostLabel}:{forward.remotePort}</code
						>
						<span
							class="shrink-0 font-mono text-2xs {forward.origin === 'preview'
								? 'text-status-running'
								: 'text-status-waiting'}"
						>
							{forward.origin === 'preview' ? '预览' : '手动'}
						</span>
						<Button
							variant="icon"
							size="sm"
							title="关闭转发"
							onclick={() => void closeForward(forward.remotePort)}
						>
							{#snippet icon()}<Icon name="close" size={11} />{/snippet}
						</Button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="shrink-0 border-t border-subtle p-2">
			<div class="flex items-center gap-1.5">
				<Input
					value={bindPort}
					placeholder="远端端口"
					class="h-6 w-20 font-mono"
					oninput={onPortInput}
				/>
				<span class="shrink-0 text-2xs text-faint">→</span>
				<span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted">自动分配本地端口</span>
				<Button variant="secondary" size="sm" loading={binding} onclick={() => void bindForward()}
					>绑定</Button
				>
			</div>
		</div>
	</div>
{/if}
