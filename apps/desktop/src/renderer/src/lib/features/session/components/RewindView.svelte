<script lang="ts">
	/**
	 * 回退视图(时间线):占据主栏「对话」的位置,替换 ConversationPane 渲染。
	 * 列出会话的用户消息作为回退点,选中后展开 —— 选择回退行为(原地回退 / 分支回退)
	 * 并二次确认。键盘优先:↑/↓ 导航、Enter 展开预览、Esc 关闭。
	 */
	import { keymap } from '$lib/shared/keymap/keymap.svelte';
	import { cx } from '$lib/shared/utils/cx';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Kbd from '$lib/ui/primitives/Kbd.svelte';
	import { fileDiffLines, removedSummary, rewind } from '../rewind.svelte';

	/** 时间线从底部(最新)开始向上延伸:旧在上、新在下,超长可滚动。 */
	const ordered = $derived(rewind.points);
	const selectedDisplay = $derived(rewind.selectedIndex);

	/** 滚动容器:双击 Esc 进入时定位到底部(最新),选择变化时跟随。 */
	let scrollEl = $state<HTMLDivElement | undefined>(undefined);
	$effect(() => {
		if (!rewind.isOpen) return;
		const target = scrollEl;
		if (!target) return;
		const frame = requestAnimationFrame(() => {
			target.scrollTo({ top: target.scrollHeight });
		});
		return () => cancelAnimationFrame(frame);
	});
	$effect(() => {
		if (!scrollEl) return;
		void rewind.selectedIndex;
		scrollEl.querySelector('[data-rewind-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	});

	/** 该回退点可选的回退行为(来自 preview.available)。 */
	const behaviorOptions = $derived.by(() => {
		const available = rewind.preview?.available ?? { native: false, fork: false };
		const options: { value: 'native' | 'fork'; label: string; hint: string }[] = [];
		if (available.native)
			options.push({ value: 'native', label: '原地回退', hint: '截断并还原文件' });
		if (available.fork) options.push({ value: 'fork', label: '分支回退', hint: '新建会话继续' });
		return options;
	});

	function selectDisplay(displayIndex: number): void {
		if (displayIndex < 0 || displayIndex >= ordered.length) return;
		rewind.select(displayIndex);
	}

	function togglePreview(): void {
		if (rewind.preview) return;
		void rewind.previewAt();
	}

	$effect(() => {
		if (!rewind.isOpen) return;
		return keymap.pushScope(
			'rewind',
			[
				{ keys: 'escape', label: '关闭', run: () => rewind.close() },
				{ keys: 'up', label: '上一个', run: () => selectDisplay(selectedDisplay - 1) },
				{ keys: 'down', label: '下一个', run: () => selectDisplay(selectedDisplay + 1) },
				{ keys: 'enter', label: '预览回退', run: () => togglePreview() }
			],
			{ modal: true }
		);
	});
</script>

<section class="flex h-full w-full flex-col bg-surface-base" aria-label="回退时间线">
	<header class="flex items-center justify-between gap-3 border-b border-subtle px-3 py-2">
		<div class="flex min-w-0 items-center gap-2">
			<Icon name="undo" size={14} class="text-muted" />
			<h2 class="truncate text-sm font-medium text-strong">回退时间线</h2>
		</div>
		<button
			type="button"
			class="rounded-default text-faint transition-colors outline-none hover:text-strong"
			title="关闭 (Esc)"
			onclick={() => rewind.close()}
		>
			<Icon name="close" size={14} />
		</button>
	</header>

	{#if rewind.points.length === 0}
		<div class="px-4 py-8 text-center text-xs text-faint">这个会话还没有可回退的消息。</div>
	{:else}
		<div class="min-h-0 flex-1 overflow-y-auto px-3 py-2" bind:this={scrollEl}>
			<div class="relative">
				<!-- 纵向轴线:与圆点同圆心(左 10px 中心)。 -->
				<div class="absolute top-0 bottom-0 left-[10px] w-px -translate-x-1/2 bg-subtle"></div>
				<ol class="relative">
					{#each ordered as point, displayIndex (point.id)}
						{@const selected = selectedDisplay === displayIndex}
						{@const expanded = selected && rewind.preview !== null}
						<li class="relative pb-1 pl-5" data-rewind-selected={selected ? 'true' : 'false'}>
							<span
								class={cx(
									'absolute top-[11px] left-[10px] h-2 w-2 -translate-x-1/2 rounded-full border',
									selected ? 'border-transparent bg-jade-500' : 'border-subtle bg-surface-raised'
								)}
							></span>
							<button
								type="button"
								class={cx(
									'group flex w-full items-start gap-2 rounded-default px-2 py-1.5 text-left transition-colors outline-none',
									selected ? 'bg-surface-muted' : 'hover:bg-surface-muted/50'
								)}
								onclick={() => {
									selectDisplay(displayIndex);
									togglePreview();
								}}
								onmouseenter={() => selectDisplay(displayIndex)}
							>
								<div class="min-w-0 flex-1">
									<div class="line-clamp-2 text-xs leading-relaxed text-normal">{point.text}</div>
									{#if point.startedAt}
										<div class="mt-0.5 text-2xs text-faint">
											{new Date(point.startedAt).toLocaleTimeString([], {
												hour: '2-digit',
												minute: '2-digit'
											})}
										</div>
									{/if}
								</div>
								<Icon
									name="chevron-down"
									size={12}
									class={cx(
										'mt-1 shrink-0 text-faint transition-transform',
										expanded && 'rotate-180'
									)}
								/>
							</button>

							{#if selected && rewind.preview}
								<div
									class="bg-surface-muted/60 mt-1 mb-2 ml-0 space-y-2 rounded-default border border-subtle p-2.5"
								>
									{#if rewind.error}
										<p class="text-xs text-cinnabar-600 dark:text-cinnabar-400">{rewind.error}</p>
									{:else}
										<p class="text-xs text-muted">
											{removedSummary(rewind.preview) || '回退后继续当前会话'}
											{#if fileDiffLines(rewind.preview).length > 0}
												· 还原 {fileDiffLines(rewind.preview).length} 个文件
											{/if}
										</p>
										{#if fileDiffLines(rewind.preview).length > 0}
											<ul
												class="max-h-20 space-y-0.5 overflow-y-auto font-mono text-2xs text-faint"
											>
												{#each fileDiffLines(rewind.preview) as diff (diff.file)}
													<li class="truncate">
														{diff.file}
														{#if diff.insertions > 0}<span class="text-jade-600 dark:text-jade-400"
																>+{diff.insertions}</span
															>{/if}
														{#if diff.deletions > 0}<span
																class="text-cinnabar-600 dark:text-cinnabar-400"
																>-{diff.deletions}</span
															>{/if}
													</li>
												{/each}
											</ul>
										{/if}

										{#if behaviorOptions.length > 1}
											<div class="flex gap-1.5">
												{#each behaviorOptions as option (option.value)}
													<button
														type="button"
														class={cx(
															'flex-1 rounded-default border px-2 py-1 text-left transition-colors outline-none',
															rewind.behavior === option.value
																? 'border-ink-500/40 bg-surface-raised'
																: 'border-subtle hover:bg-surface-raised/60'
														)}
														onclick={() => rewind.setBehavior(option.value)}
													>
														<span class="block text-2xs text-strong">{option.label}</span>
														<span class="block text-2xs text-faint">{option.hint}</span>
													</button>
												{/each}
											</div>
										{/if}

										<div class="flex justify-end gap-2">
											<Button variant="ghost" size="sm" onclick={() => rewind.close()}>取消</Button>
											<Button
												variant="primary"
												size="sm"
												disabled={rewind.busy}
												onclick={() => void rewind.apply()}
											>
												{rewind.busy ? '回退中…' : '确认回退'}
											</Button>
										</div>
									{/if}
								</div>
							{:else if selected && rewind.busy}
								<div class="mt-1 mb-2 ml-0 px-2 py-1 text-2xs text-faint">加载回退预览…</div>
							{/if}
						</li>
					{/each}
				</ol>
				<div class="relative mt-1 flex items-center gap-2 pl-5 text-2xs text-faint">
					<span
						class="absolute top-1/2 left-[10px] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-subtle bg-surface-raised"
					></span>
					现在
				</div>
			</div>
		</div>
	{/if}

	<footer class="flex items-center gap-3 border-t border-subtle px-3 py-1.5 text-2xs text-faint">
		<span class="flex items-center gap-1.5">
			<Kbd keys="up" />
			<Kbd keys="down" /> 选择
			<span class="mx-0.5"></span>
			<Kbd keys="enter" /> 预览
			<span class="mx-0.5"></span>
			<Kbd keys="escape" /> 关闭
		</span>
	</footer>
</section>
