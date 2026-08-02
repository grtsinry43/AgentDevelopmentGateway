<script lang="ts">
	/**
	 * Web 预览面板:agent 用 `preview` 工具打开的 localhost 页面。
	 * 用 <webview> 嵌入并拦截导航 —— 只允许解析出的 host+端口,跳转外站一律阻止。
	 */
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { webPreview } from '$lib/shared/preview/web-preview.svelte';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let view: any = $state();

	interface PreviewNavigationEvent {
		url: string;
		preventDefault(): void;
	}

	function isAllowed(url: string): boolean {
		const entry = webPreview.entry;
		if (!entry) return false;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
			if (parsed.hostname !== entry.host) return false;
			const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
			return port === entry.port;
		} catch {
			return false;
		}
	}

	$effect(() => {
		const wv = view;
		if (!wv) return;
		const onNavigate = (event: PreviewNavigationEvent): void => {
			if (!isAllowed(event.url)) event.preventDefault();
		};
		const onNewWindow = (event: PreviewNavigationEvent): void => {
			if (!isAllowed(event.url)) event.preventDefault();
		};
		wv.addEventListener('will-navigate', onNavigate);
		wv.addEventListener('new-window', onNewWindow);
		return () => {
			wv.removeEventListener('will-navigate', onNavigate);
			wv.removeEventListener('new-window', onNewWindow);
		};
	});
</script>

{#if webPreview.entry}
	<div class="flex h-full min-h-0 flex-col">
		<div class="flex h-9 shrink-0 items-center gap-1 border-b border-subtle px-2">
			<Icon name="globe" size={12} class="shrink-0 text-faint" />
			<span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted" title={webPreview.url}>
				{webPreview.url}
			</span>
			<Button variant="icon" size="sm" title="重新加载" onclick={() => webPreview.reload()}>
				{#snippet icon()}
					<Icon name="refresh" size={11} />
				{/snippet}
			</Button>
			<Button
				variant="icon"
				size="sm"
				title="在浏览器打开"
				onclick={() => {
					if (isAllowed(webPreview.url ?? '')) window.open(webPreview.url!, '_blank');
				}}
			>
				{#snippet icon()}
					<Icon name="globe" size={11} />
				{/snippet}
			</Button>
			<Button variant="icon" size="sm" title="关闭预览" onclick={() => webPreview.clear()}>
				{#snippet icon()}
					<Icon name="close" size={11} />
				{/snippet}
			</Button>
		</div>
		<div class="min-h-0 flex-1 bg-white">
			{#key webPreview.revision}
				<svelte:element
					this={"webview"}
					bind:this={view}
					src={webPreview.url}
					class="h-full w-full"
				/>
			{/key}
		</div>
	</div>
{:else}
	<div class="grid h-full place-items-center p-6 text-center text-xs text-faint">
		Agent 调用 preview 工具后,这里会显示它启动的本地服务。
	</div>
{/if}
