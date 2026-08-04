<script lang="ts">
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		text: string;
	}

	let { text }: Props = $props();

	/** 解析 `/command args` —— 首行以斜杠开头。多行只把首行当命令。 */
	const match = $derived.by<{ command: string; args: string } | null>(() => {
		const trimmed = text.trim();
		const firstLine = trimmed.split('\n')[0] ?? '';
		const commandMatch = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(firstLine);
		if (!commandMatch) return null;
		const rest = trimmed.slice(firstLine.length).trimStart();
		return {
			command: commandMatch[1] ?? '',
			args: `${commandMatch[2] ?? ''}${rest ? `\n${rest}` : ''}`.trim()
		};
	});
</script>

{#if match}
	<div
		class="inline-flex max-w-full items-start gap-2 rounded-default border border-jade-500/20 bg-jade-500/10 px-2.5 py-1.5 align-baseline"
	>
		<span class="shrink-0 font-mono text-[0.92em] font-bold text-accent">/{match.command}</span>
		{#if match.args}
			<span
				class={cx(
					'min-w-0 font-mono text-[0.92em] whitespace-pre-wrap',
					text.split('\n').length > 1 ? 'text-normal' : 'text-muted'
				)}>{match.args}</span
			>
		{/if}
	</div>
{/if}
