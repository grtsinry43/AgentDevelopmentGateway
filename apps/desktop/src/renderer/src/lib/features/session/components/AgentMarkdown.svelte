<script lang="ts">
	import { Markdown } from 'svmarkdown';
	import type { SvmdComponentMap, SvmdParseOptions, SvmdRenderOptions } from 'svmarkdown';
	import { agentGatewayLinkifyPlugin } from '../markdown/agent-gateway-linkify-plugin';
	import { taskListPlugin } from '../markdown/task-list-plugin';
	import AgentMarkdownCode from './AgentMarkdownCode.svelte';
	import AgentMarkdownLink from './AgentMarkdownLink.svelte';
	import AgentMarkdownListItem from './AgentMarkdownListItem.svelte';

	interface Props {
		content: string;
	}

	let { content }: Props = $props();

	const components = {
		a: AgentMarkdownLink,
		code: AgentMarkdownCode,
		li: AgentMarkdownListItem
	} satisfies SvmdComponentMap;
	const parseOptions = {
		markdownItPlugins: [agentGatewayLinkifyPlugin, taskListPlugin],
		markdownItOptions: {
			html: false,
			linkify: true,
			typographer: true
		}
	} satisfies SvmdParseOptions;
	const renderOptions = {
		allowDangerousHtml: false,
		softBreak: 'newline'
	} satisfies SvmdRenderOptions;
</script>

<div class="agent-markdown w-full min-w-0 text-sm leading-6 text-normal">
	<Markdown {content} {components} {parseOptions} {renderOptions} inferComponentBlocks={false} />
</div>

<style>
	.agent-markdown {
		overflow-wrap: anywhere;
	}

	.agent-markdown :global(p) {
		margin-block: 0 0.75rem;
	}

	.agent-markdown :global(p:last-child) {
		margin-bottom: 0;
	}

	.agent-markdown :global(h1),
	.agent-markdown :global(h2),
	.agent-markdown :global(h3),
	.agent-markdown :global(h4),
	.agent-markdown :global(h5),
	.agent-markdown :global(h6) {
		margin-block: 1.25rem 0.5rem;
		font-weight: 600;
		line-height: 1.45;
		color: var(--text-strong);
	}

	.agent-markdown :global(h1:first-child),
	.agent-markdown :global(h2:first-child),
	.agent-markdown :global(h3:first-child),
	.agent-markdown :global(h4:first-child),
	.agent-markdown :global(h5:first-child),
	.agent-markdown :global(h6:first-child) {
		margin-top: 0;
	}

	.agent-markdown :global(h1) {
		font-size: var(--text-xl);
	}

	.agent-markdown :global(h2) {
		font-size: var(--text-lg);
	}

	.agent-markdown :global(h3),
	.agent-markdown :global(h4),
	.agent-markdown :global(h5),
	.agent-markdown :global(h6) {
		font-size: var(--text-base);
	}

	.agent-markdown :global(ul),
	.agent-markdown :global(ol) {
		margin-block: 0.75rem;
		padding-left: 1.25rem;
	}

	.agent-markdown :global(ul) {
		list-style: disc;
	}

	.agent-markdown :global(ol) {
		list-style: decimal;
	}

	.agent-markdown :global(li + li) {
		margin-top: 0.25rem;
	}

	.agent-markdown :global(li > ul),
	.agent-markdown :global(li > ol) {
		margin-block: 0.25rem;
	}

	.agent-markdown :global(blockquote) {
		margin-block: 0.875rem;
		border-left: 2px solid var(--border-accent);
		padding-left: 0.75rem;
		color: var(--text-muted);
	}

	.agent-markdown :global(blockquote p:last-child) {
		margin-bottom: 0;
	}

	.agent-markdown :global(hr) {
		margin-block: 1.25rem;
		border: 0;
		border-top: 1px solid var(--border-subtle);
	}

	.agent-markdown :global(code:not(.agent-code__content)) {
		border-radius: var(--radius-default);
		background: var(--surface-active);
		padding: 0.1rem 0.3rem;
		font-family: var(--font-mono);
		font-size: 0.92em;
	}

	.agent-markdown :global(table) {
		display: block;
		max-width: 100%;
		margin-block: 0.875rem;
		overflow-x: auto;
		border-collapse: collapse;
		font-size: var(--text-xs);
	}

	.agent-markdown :global(th),
	.agent-markdown :global(td) {
		border: 1px solid var(--border-default);
		padding: 0.35rem 0.5rem;
		text-align: left;
		vertical-align: top;
	}

	.agent-markdown :global(th) {
		background: var(--surface-panel);
		font-weight: 600;
		color: var(--text-strong);
	}

	.agent-markdown :global(strong) {
		font-weight: 600;
		color: var(--text-strong);
	}
</style>
