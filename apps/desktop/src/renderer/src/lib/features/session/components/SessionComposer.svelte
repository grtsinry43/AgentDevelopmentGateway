<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';
	import MarkdownEditor from '$lib/ui/editor/MarkdownEditor.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import type { GatewayAdapterAvailability, GatewaySession } from '@agent-gateway/shared';
	import { Prec, type Extension } from '@codemirror/state';
	import { EditorView, keymap } from '@codemirror/view';
	import type { ExecutionPreset, SessionWorkspaceState } from '../session-workspace.svelte';
	import InteractionTray from './InteractionTray.svelte';
	import InputQueuePanel from './InputQueuePanel.svelte';

	interface Props {
		workspace: SessionWorkspaceState;
		height?: number;
	}

	let { workspace, height = 160 }: Props = $props();
	let text = $state('');
	let adapterOverride = $state<GatewayAdapterAvailability['adapterId'] | undefined>(undefined);
	let installationOverride = $state<string | undefined>(undefined);

	const creating = $derived(!workspace.selectedSessionId);
	const selectedAdapterId = $derived(
		adapterOverride ?? workspace.availableAdapters[0]?.adapterId ?? ''
	);
	const selectedAdapter = $derived(
		workspace.availableAdapters.find((adapter) => adapter.adapterId === selectedAdapterId)
	);
	const selectedInstallation = $derived(
		installationOverride ?? selectedAdapter?.installations[0]?.path
	);
	const activeAdapter = $derived(
		workspace.adapters.find((adapter) => adapter.adapterId === workspace.selectedSession?.adapterId)
	);
	const adapterLabel = $derived(
		creating
			? (selectedAdapter?.descriptor.displayName ?? '没有可用 Agent')
			: (activeAdapter?.descriptor.displayName ?? workspace.selectedSession?.adapterId ?? 'Agent')
	);
	const modelLabel = $derived(workspace.selectedSession?.model ?? 'Agent 默认模型');
	const reasoningLabel = $derived(workspace.selectedSession?.reasoningEffort ?? '默认思考');
	const workModeLabel = $derived(
		workspace.selectedSession?.execution.effective.workMode === 'plan' ? 'Plan' : 'Build'
	);
	const permissionLabel = $derived.by(() => {
		const execution = workspace.selectedSession?.execution.effective;
		if (!execution) return '发送时确认';
		const action = execution.approval.defaultAction;
		if (action === 'allow') return '自动允许';
		if (action === 'deny') return '默认拒绝';
		return '每次询问';
	});
	const executionCapabilities = $derived(workspace.selectedSession?.capabilities.execution);
	const executionCanUpdate = $derived(executionCapabilities?.update === 'in-session');
	const executionPreset = $derived(
		classifyExecutionPreset(workspace.selectedSession?.execution.effective)
	);
	const tokenLabel = $derived(formatTokens(workspace.usage?.totalTokens));
	const contextLabel = $derived(
		workspace.usage?.contextWindow
			? `${tokenLabel} / ${formatTokens(workspace.usage.contextWindow)}`
			: tokenLabel
	);
	const canSubmit = $derived(
		text.trim().length > 0 && !workspace.sending && (!creating || Boolean(selectedAdapter))
	);
	const composerExtensions = $derived<Extension>([
		Prec.highest(
			keymap.of([
				{
					key: 'Enter',
					run: (view) => {
						if (view.composing) return false;
						void submit();
						return true;
					}
				}
			])
		),
		EditorView.theme({
			'&': { height: '100%' },
			'.cm-gutters': { display: 'none' },
			'.cm-content': {
				minHeight: creating ? '100%' : '104px',
				padding: creating ? '24px 0 48px' : '12px 0 20px'
			},
			'.cm-scroller': { height: '100%', overflow: 'auto' }
		})
	]);

	async function submit(): Promise<void> {
		const value = text.trim();
		if (!value || !canSubmit) return;

		const accepted = creating
			? selectedAdapter
				? await workspace.createTextSession(
						value,
						selectedAdapter.adapterId,
						selectedAdapter.installations.length > 1 ? selectedInstallation : undefined
					)
				: false
			: await workspace.sendText(value);
		if (accepted) text = '';
	}

	function formatTokens(value: number | undefined): string {
		if (value === undefined) return '上下文 —';
		if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m tokens`;
		if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tokens`;
		return `${value} tokens`;
	}

	function classifyExecutionPreset(
		execution: GatewaySession['execution']['effective'] | undefined
	): ExecutionPreset | 'custom' {
		if (
			!execution ||
			execution.approval.reviewer !== 'user' ||
			execution.approval.rules.length > 0
		) {
			return 'custom';
		}
		if (
			execution.workMode === 'build' &&
			execution.approval.defaultAction === 'allow' &&
			execution.sandbox.filesystem === 'unrestricted' &&
			execution.sandbox.network === 'allow'
		) {
			return 'full-access';
		}
		if (
			execution.workMode === 'build' &&
			execution.approval.defaultAction === 'ask' &&
			execution.sandbox.filesystem === 'read-only' &&
			execution.sandbox.network === 'ask'
		) {
			return 'read-only';
		}
		if (
			execution.workMode === 'build' &&
			execution.approval.defaultAction === 'ask' &&
			execution.sandbox.filesystem === 'workspace-write' &&
			execution.sandbox.network === 'ask'
		) {
			return 'standard';
		}
		return 'custom';
	}

	function supportsPreset(preset: ExecutionPreset): boolean {
		const capabilities = executionCapabilities;
		if (!capabilities || !capabilities.workModes.includes('build')) return false;
		if (!capabilities.approvalReviewers.includes('user')) return false;
		if (preset === 'full-access') {
			return (
				capabilities.approvalActions.includes('allow') &&
				capabilities.filesystemSandbox.includes('unrestricted') &&
				capabilities.networkAccess.includes('allow')
			);
		}
		return (
			capabilities.approvalActions.includes('ask') &&
			capabilities.filesystemSandbox.includes(
				preset === 'read-only' ? 'read-only' : 'workspace-write'
			) &&
			capabilities.networkAccess.includes('ask')
		);
	}
</script>

<section
	class={cx(
		'relative flex min-h-0 flex-col bg-surface-raised',
		creating ? 'min-h-0 flex-1' : 'shrink-0'
	)}
	style:height={creating ? undefined : `${height}px`}
	aria-label={creating ? '新会话草稿' : '会话输入'}
>
	{#if !creating && workspace.selectedSession?.pendingInteractions[0]}
		{#key workspace.selectedSession.pendingInteractions[0].id}
			<InteractionTray
				request={workspace.selectedSession.pendingInteractions[0]}
				pendingCount={workspace.selectedSession.pendingInteractions.length}
				{workspace}
			/>
		{/key}
	{/if}

	{#if !creating && workspace.inputQueue.length > 0}
		<InputQueuePanel {workspace} />
	{/if}

	<div class="min-h-0 flex-1">
		<MarkdownEditor
			bind:value={text}
			appearance="bare"
			placeholder={creating
				? '写下任务、背景、约束和你希望 Agent 完成的工作…'
				: '继续说明接下来要做什么…'}
			readOnly={workspace.sending || (creating && workspace.availableAdapters.length === 0)}
			extensions={composerExtensions}
			class="h-full"
		/>
	</div>

	<footer class="flex h-9 shrink-0 items-center gap-0.5 border-t border-subtle px-2">
		{#if creating}
			<label class="sr-only" for="session-adapter">Agent</label>
			<select
				id="session-adapter"
				class="h-7 max-w-36 rounded-default bg-transparent px-1.5 text-xs font-medium text-strong hover:bg-surface-hover disabled:text-faint"
				value={selectedAdapterId}
				disabled={workspace.availableAdapters.length === 0 || workspace.sending}
				onchange={(event) => {
					adapterOverride = event.currentTarget.value as GatewayAdapterAvailability['adapterId'];
					installationOverride = undefined;
				}}
			>
				{#if workspace.availableAdapters.length === 0}
					<option value="">没有可用 Agent</option>
				{/if}
				{#each workspace.availableAdapters as adapter (adapter.adapterId)}
					<option value={adapter.adapterId}>{adapter.descriptor.displayName}</option>
				{/each}
			</select>

			{#if selectedAdapter && selectedAdapter.installations.length > 1}
				<span class="h-3.5 w-px bg-subtle" aria-hidden="true"></span>
				<label class="sr-only" for="session-installation">Agent 安装</label>
				<select
					id="session-installation"
					class="h-7 max-w-44 rounded-default bg-transparent px-1.5 font-mono text-2xs text-muted hover:bg-surface-hover"
					value={selectedInstallation}
					disabled={workspace.sending}
					onchange={(event) => (installationOverride = event.currentTarget.value)}
				>
					{#each selectedAdapter.installations as installation (installation.path)}
						<option value={installation.path}>{installation.path}</option>
					{/each}
				</select>
			{/if}
		{:else}
			<span class="px-1.5 text-xs font-medium text-strong">{adapterLabel}</span>
		{/if}

		<span class="h-3.5 w-px bg-subtle" aria-hidden="true"></span>
		<button
			type="button"
			class="h-7 rounded-default px-1.5 text-xs text-muted disabled:cursor-default disabled:opacity-100"
			disabled
			title="等待 Agent 提供可选模型目录">{modelLabel}</button
		>
		<button
			type="button"
			class="hidden h-7 rounded-default px-1.5 text-xs text-faint disabled:cursor-default disabled:opacity-100 lg:block"
			disabled
			title="等待 Agent 提供可选思考强度">{reasoningLabel}</button
		>

		<span class="h-3.5 w-px bg-subtle" aria-hidden="true"></span>
		{#if creating}
			<button
				type="button"
				class="h-7 rounded-default px-1.5 text-xs text-muted disabled:cursor-default disabled:opacity-100"
				disabled
				title="新会话执行设置将在后续接入">{workModeLabel}</button
			>
			<button
				type="button"
				class="hidden h-7 rounded-default px-1.5 text-xs text-muted disabled:cursor-default disabled:opacity-100 xl:block"
				disabled
				title="新会话权限设置将在后续接入">{permissionLabel}</button
			>
		{:else if workspace.selectedSession}
			<label class="sr-only" for="session-work-mode">工作模式</label>
			<select
				id="session-work-mode"
				class="h-7 rounded-default bg-transparent px-1.5 text-xs text-muted hover:bg-surface-hover disabled:cursor-default disabled:text-faint"
				value={workspace.selectedSession.execution.effective.workMode}
				disabled={!executionCanUpdate || workspace.controlling}
				title={executionCanUpdate ? '切换工作模式' : '当前 Agent 不支持会话内切换工作模式'}
				onchange={(event) =>
					void workspace.setWorkMode(event.currentTarget.value as 'build' | 'plan')}
			>
				{#each executionCapabilities?.workModes ?? [] as mode (mode)}
					<option value={mode}>{mode === 'plan' ? 'Plan' : 'Build'}</option>
				{/each}
			</select>

			<label class="sr-only" for="session-permission-preset">权限模式</label>
			<select
				id="session-permission-preset"
				class="hidden h-7 rounded-default bg-transparent px-1.5 text-xs text-muted hover:bg-surface-hover disabled:cursor-default disabled:text-faint lg:block"
				value={executionPreset}
				disabled={!executionCanUpdate || workspace.controlling}
				title={executionCanUpdate
					? '权限预设会原子更新批准、文件系统和网络策略'
					: '当前 Agent 不支持会话内切换权限'}
				onchange={(event) => {
					const preset = event.currentTarget.value;
					if (preset !== 'custom') void workspace.setExecutionPreset(preset as ExecutionPreset);
				}}
			>
				{#if supportsPreset('standard')}<option value="standard">标准</option>{/if}
				{#if supportsPreset('read-only')}<option value="read-only">只读</option>{/if}
				{#if supportsPreset('full-access')}<option value="full-access">完全访问</option>{/if}
				<option value="custom" disabled>自定义</option>
			</select>
		{/if}

		<div class="ml-auto flex min-w-0 items-center gap-1">
			{#if !creating && workspace.selectedSession?.pendingInteractions.length}
				<span class="rounded-default bg-amber-500/10 px-1.5 py-1 text-2xs text-status-waiting">
					待处理 {workspace.selectedSession.pendingInteractions.length}
				</span>
			{/if}
			<span class="hidden truncate px-1 text-2xs text-faint sm:block" title="当前会话用量">
				{contextLabel}
			</span>
			<span class="hidden text-2xs text-faint 2xl:inline">Enter 发送</span>
			<Button
				variant="primary"
				size="sm"
				loading={workspace.sending}
				disabled={!canSubmit}
				onclick={() => void submit()}
			>
				{creating ? '开始' : '发送'}
			</Button>
		</div>
	</footer>

	{#if creating && !workspace.loading && workspace.availableAdapters.length === 0}
		<p class="shrink-0 border-t border-cinnabar-500/20 px-3 py-1 text-xs text-status-error">
			当前没有可用的 Agent runtime。
		</p>
	{/if}
</section>
