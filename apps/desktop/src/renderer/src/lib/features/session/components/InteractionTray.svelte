<script lang="ts">
	import Button from '$lib/ui/primitives/Button.svelte';
	import type { GatewaySession, InteractionResolutionWire } from '@agent-gateway/shared';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';
	import DiffViewer from './DiffViewer.svelte';

	type InteractionRequest = GatewaySession['pendingInteractions'][number];

	interface Props {
		request: InteractionRequest;
		pendingCount: number;
		workspace: SessionWorkspaceState;
	}

	let { request, pendingCount, workspace }: Props = $props();
	let answers = $state<Record<string, string[]>>({});
	let customAnswers = $state<Record<string, string>>({});
	let denyMessage = $state('');
	let abortTurn = $state(false);
	let grantScope = $state<'once' | 'turn' | 'session'>('once');
	let structuredResponse = $state('{}');
	let localError = $state<string | undefined>(undefined);

	const resolving = $derived(workspace.resolvingInteractionId === request.id);
	const questionComplete = $derived(
		request.kind !== 'question' ||
			request.questions.every((question) => {
				const selected = answers[question.id] ?? [];
				const custom = customAnswers[question.id]?.trim();
				return selected.length > 0 || Boolean(custom);
			})
	);

	function setSingleAnswer(questionId: string, value: string): void {
		answers = { ...answers, [questionId]: [value] };
	}

	function toggleAnswer(questionId: string, value: string, checked: boolean): void {
		const current = answers[questionId] ?? [];
		answers = {
			...answers,
			[questionId]: checked
				? [...current.filter((entry) => entry !== value), value]
				: current.filter((entry) => entry !== value)
		};
	}

	function setCustomAnswer(questionId: string, value: string): void {
		customAnswers = { ...customAnswers, [questionId]: value };
	}

	async function resolve(resolution: InteractionResolutionWire): Promise<void> {
		localError = undefined;
		await workspace.resolveInteraction(resolution);
	}

	async function submitQuestions(): Promise<void> {
		if (request.kind !== 'question' || !questionComplete) return;
		const resolvedAnswers = Object.fromEntries(
			request.questions.map((question) => {
				const selected = [...(answers[question.id] ?? [])];
				const custom = customAnswers[question.id]?.trim();
				if (custom) selected.push(custom);
				return [question.id, selected];
			})
		);
		await resolve({ kind: 'question', id: request.id, answers: resolvedAnswers });
	}

	async function submitStructured(
		createResolution: (content: unknown) => InteractionResolutionWire
	): Promise<void> {
		try {
			const content: unknown = JSON.parse(structuredResponse);
			await resolve(createResolution(content));
		} catch (error) {
			localError = error instanceof Error ? `JSON 无效：${error.message}` : 'JSON 无效';
		}
	}

	function formatOpaque(value: unknown): string {
		if (value === undefined) return '—';
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function permissionCommand(): string | undefined {
		if (request.kind !== 'tool_permission' || request.toolKind !== 'terminal') return undefined;
		if (!isRecord(request.input)) return undefined;
		return typeof request.input.command === 'string' ? request.input.command : undefined;
	}

	function permissionFilePath(): string | undefined {
		if (request.kind !== 'tool_permission' || request.toolKind !== 'file-edit') return undefined;
		if (!isRecord(request.input)) return undefined;
		for (const key of ['file_path', 'path', 'notebook_path']) {
			if (typeof request.input[key] === 'string') return request.input[key];
		}
		return undefined;
	}
</script>

<aside
	class="absolute inset-x-2 bottom-full z-30 mb-2 max-h-[min(62vh,34rem)] overflow-y-auto rounded-panel border border-line bg-surface-overlay shadow-subtle backdrop-blur-xl"
	aria-label="Agent 等待用户交互"
>
	<header
		class="sticky top-0 z-10 flex h-8 items-center border-b border-subtle bg-surface-overlay px-3 backdrop-blur-xl"
	>
		<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-status-waiting" aria-hidden="true"
		></span>
		<strong class="ml-2 text-xs font-medium text-strong">
			{request.kind === 'tool_permission'
				? '工具权限'
				: request.kind === 'question'
					? 'Agent 提问'
					: request.kind === 'permission_grant'
						? '权限配置请求'
						: request.kind === 'host_dialog'
							? 'Agent 对话框'
							: 'MCP 请求'}
		</strong>
		{#if pendingCount > 1}
			<span class="ml-auto text-2xs text-faint">还有 {pendingCount - 1} 项等待处理</span>
		{/if}
	</header>

	<div class="p-3">
		{#if request.kind === 'tool_permission'}
			<p class="text-sm leading-5 text-normal">{request.prompt}</p>
			<div class="mt-2 overflow-hidden rounded-default bg-surface-active">
				<div class="flex h-6 items-center gap-2 border-b border-subtle px-2 text-2xs text-faint">
					<span>{request.toolName}</span>
					<span class="font-mono">{request.toolKind}</span>
				</div>
				{#if request.proposedChangeSet}
					<DiffViewer changeSet={request.proposedChangeSet} />
				{:else if request.toolKind === 'file-edit'}
					<div class="px-2 py-2 text-xs text-muted">
						{#if permissionFilePath()}
							<code class="font-mono text-normal">{permissionFilePath()}</code>
						{/if}
						<p class="mt-1">无法从本次工具输入安全生成变更预览。</p>
					</div>
				{:else}
					<pre
						class="max-h-40 overflow-auto px-2 py-1.5 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-strong"><code
							>{permissionCommand() ?? formatOpaque(request.input)}</code
						></pre>
				{/if}
			</div>
			{#if request.resources?.length}
				<div class="mt-2 space-y-1">
					{#each request.resources as resource (resource)}
						<code
							class="block rounded-default bg-surface-active px-2 py-1 font-mono text-xs text-muted"
						>
							{resource}
						</code>
					{/each}
				</div>
			{/if}
			<div class="mt-3 grid grid-cols-[1fr_auto] gap-2">
				<input
					class="h-7 min-w-0 rounded-default border border-line bg-surface-raised px-2 text-xs text-normal outline-none focus:border-line-accent"
					placeholder="拒绝原因（可选）"
					value={denyMessage}
					oninput={(event) => (denyMessage = event.currentTarget.value)}
				/>
				<label class="flex items-center gap-1.5 text-xs text-faint">
					<input type="checkbox" bind:checked={abortTurn} /> 中止本轮
				</label>
			</div>
			<div class="mt-3 flex justify-end gap-1.5">
				<Button
					variant="danger"
					size="sm"
					disabled={resolving}
					onclick={() =>
						void resolve({
							kind: 'tool_permission',
							id: request.id,
							decision: {
								behavior: 'deny',
								...(denyMessage.trim() ? { message: denyMessage.trim() } : {}),
								...(abortTurn ? { abortTurn: true } : {})
							}
						})}>拒绝</Button
				>
				<Button
					variant="primary"
					size="sm"
					loading={resolving}
					onclick={() =>
						void resolve({
							kind: 'tool_permission',
							id: request.id,
							decision: { behavior: 'allow', scope: 'once' }
						})}>允许这一次</Button
				>
			</div>
		{:else if request.kind === 'question'}
			<div class="space-y-4">
				{#each request.questions as question (question.id)}
					<fieldset>
						<legend class="text-sm leading-5 font-medium text-strong">
							{#if question.header}<span class="mr-1 text-accent">{question.header}</span>{/if}
							{question.question}
						</legend>
						{#if question.options?.length}
							<div class="mt-2 grid gap-1.5">
								{#each question.options as option (option.id)}
									<label
										class="flex cursor-pointer gap-2 rounded-default px-2 py-1.5 hover:bg-surface-hover"
									>
										<input
											type={question.multiSelect ? 'checkbox' : 'radio'}
											name={`interaction-${request.id}-${question.id}`}
											checked={(answers[question.id] ?? []).includes(option.id)}
											onchange={(event) =>
												question.multiSelect
													? toggleAnswer(question.id, option.id, event.currentTarget.checked)
													: setSingleAnswer(question.id, option.id)}
										/>
										<span class="min-w-0">
											<span class="block text-xs text-normal">{option.label}</span>
											{#if option.description}
												<span class="block text-2xs leading-4 text-faint">{option.description}</span
												>
											{/if}
											{#if option.preview}
												<code class="mt-1 block text-2xs whitespace-pre-wrap text-muted"
													>{option.preview}</code
												>
											{/if}
										</span>
									</label>
								{/each}
							</div>
						{/if}
						{#if !question.options?.length || question.allowCustom}
							<input
								type={question.isSecret ? 'password' : 'text'}
								class="mt-2 h-8 w-full rounded-default border border-line bg-surface-raised px-2 text-sm text-normal outline-none focus:border-line-accent"
								placeholder={question.options?.length ? '其他回答…' : '输入回答…'}
								value={question.options?.length
									? (customAnswers[question.id] ?? '')
									: (answers[question.id]?.[0] ?? '')}
								oninput={(event) =>
									question.options?.length
										? setCustomAnswer(question.id, event.currentTarget.value)
										: setSingleAnswer(question.id, event.currentTarget.value)}
							/>
						{/if}
					</fieldset>
				{/each}
			</div>
			<div class="mt-4 flex justify-end gap-1.5">
				<Button
					variant="ghost"
					size="sm"
					disabled={resolving}
					onclick={() => void resolve({ kind: 'question_rejected', id: request.id })}>不回答</Button
				>
				<Button
					variant="primary"
					size="sm"
					loading={resolving}
					disabled={!questionComplete}
					onclick={() => void submitQuestions()}>提交回答</Button
				>
			</div>
		{:else if request.kind === 'permission_grant'}
			<p class="text-sm leading-5 text-normal">{request.prompt}</p>
			<pre
				class="scroll-thin mt-2 max-h-40 overflow-auto rounded-default bg-surface-active p-2 font-mono text-2xs text-muted">{formatOpaque(
					request.requestedProfile
				)}</pre>
			<div class="mt-3 flex items-center justify-end gap-1.5">
				<label class="text-xs text-faint" for={`grant-scope-${request.id}`}>作用域</label>
				<select
					id={`grant-scope-${request.id}`}
					class="h-7 rounded-default border border-line bg-surface-raised px-1.5 text-xs text-normal"
					bind:value={grantScope}
				>
					<option value="once">一次</option>
					<option value="turn">本轮</option>
					<option value="session">本会话</option>
				</select>
				<Button
					variant="primary"
					size="sm"
					loading={resolving}
					onclick={() =>
						void resolve({
							kind: 'permission_grant',
							id: request.id,
							grantedProfile: request.requestedProfile,
							scope: grantScope
						})}>授予权限</Button
				>
			</div>
			<p class="mt-2 text-2xs text-faint">
				当前统一协议只定义了授权响应，没有定义用户拒绝该配置的响应。
			</p>
		{:else if request.kind === 'host_dialog'}
			<p class="text-sm text-normal">Agent 请求打开未注册的对话框：{request.dialogKind}</p>
			<pre
				class="scroll-thin mt-2 max-h-40 overflow-auto rounded-default bg-surface-active p-2 font-mono text-2xs text-muted">{formatOpaque(
					request.payload
				)}</pre>
			<p class="mt-2 text-2xs leading-4 text-faint">
				没有匹配的专用 renderer。按照协议，未知 dialog kind 必须安全取消，不能猜测 payload 的含义。
			</p>
			<div class="mt-3 flex justify-end">
				<Button
					variant="secondary"
					size="sm"
					loading={resolving}
					onclick={() =>
						void resolve({
							kind: 'host_dialog',
							id: request.id,
							outcome: { behavior: 'cancelled' }
						})}>取消并返回 Agent</Button
				>
			</div>
		{:else}
			<div class="flex items-center gap-2 text-xs text-faint">
				<span>{request.serverName}</span>
				<span>·</span>
				<span>{request.mode === 'form' ? '结构化表单' : '外部流程'}</span>
			</div>
			<p class="mt-1 text-sm leading-5 text-normal">{request.message}</p>
			{#if request.requestedSchema !== undefined}
				<details class="mt-2 text-xs text-faint">
					<summary class="cursor-pointer">查看请求 Schema</summary>
					<pre
						class="scroll-thin mt-1 max-h-32 overflow-auto rounded-default bg-surface-active p-2 font-mono text-2xs text-muted">{formatOpaque(
							request.requestedSchema
						)}</pre>
				</details>
			{/if}
			<label class="mt-3 block text-xs text-faint" for={`elicitation-response-${request.id}`}>
				响应内容（JSON）
			</label>
			<textarea
				id={`elicitation-response-${request.id}`}
				class="mt-1 h-20 w-full resize-y rounded-default border border-line bg-surface-raised p-2 font-mono text-xs text-normal outline-none focus:border-line-accent"
				bind:value={structuredResponse}></textarea>
			<div class="mt-3 flex justify-end gap-1.5">
				<Button
					variant="ghost"
					size="sm"
					disabled={resolving}
					onclick={() =>
						void resolve({
							kind: 'elicitation',
							id: request.id,
							outcome: { behavior: 'cancelled' }
						})}>取消</Button
				>
				<Button
					variant="primary"
					size="sm"
					loading={resolving}
					onclick={() =>
						void submitStructured((content) => ({
							kind: 'elicitation',
							id: request.id,
							outcome: { behavior: 'completed', content }
						}))}>完成</Button
				>
			</div>
		{/if}

		{#if localError}
			<p class="mt-2 text-xs text-status-error">{localError}</p>
		{/if}
	</div>
</aside>
