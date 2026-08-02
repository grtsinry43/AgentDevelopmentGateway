import type { SvmdMarkdownItPlugin, SvmdParseOptions } from 'svmarkdown';

type MarkdownItInstance = NonNullable<SvmdParseOptions['markdownIt']>;

/** Teach markdown-it linkify to recognize bare agent-gateway:// URIs. */
export const agentGatewayLinkifyPlugin = ((markdownIt: MarkdownItInstance) => {
	markdownIt.linkify.add('agent-gateway:', 'http:');
}) satisfies SvmdMarkdownItPlugin;
