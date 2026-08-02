import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdown, type SvmdElementNode } from 'svmarkdown';
import { parseAgentGatewayFileHref } from '../src/renderer/src/lib/features/files/agent-gateway-uri.js';
import {
	highlightCode,
	languageFromPath,
	normalizeCodeLanguage
} from '../src/renderer/src/lib/features/session/markdown/highlight.js';
import { agentGatewayLinkifyPlugin } from '../src/renderer/src/lib/features/session/markdown/agent-gateway-linkify-plugin.js';
import { taskListPlugin } from '../src/renderer/src/lib/features/session/markdown/task-list-plugin.js';

test('marks task list items and removes the source checkbox marker', () => {
	const root = parseMarkdown('- [x] shipped\n- [ ] pending', {
		markdownItPlugins: [taskListPlugin]
	});
	const list = root.children[0] as SvmdElementNode;
	const completed = list.children[0] as SvmdElementNode;
	const pending = list.children[1] as SvmdElementNode;

	assert.equal(list.attrs['data-task-list'], 'true');
	assert.deepEqual(completed.attrs, { 'data-task': 'true', 'data-checked': 'true' });
	assert.deepEqual(pending.attrs, { 'data-task': 'true', 'data-checked': 'false' });
	assert.equal(completed.children[0]?.kind, 'text');
	if (completed.children[0]?.kind === 'text') assert.equal(completed.children[0].value, 'shipped');
});

test('parses agent-gateway file hrefs without treating the first segment as a host', () => {
	assert.equal(parseAgentGatewayFileHref('agent-gateway://src/app.ts'), 'src/app.ts');
	assert.equal(parseAgentGatewayFileHref('agent-gateway:///src/app.ts'), 'src/app.ts');
	assert.equal(parseAgentGatewayFileHref('agent-gateway://src%2Fapp.ts'), 'src/app.ts');
	assert.equal(parseAgentGatewayFileHref('https://example.com/a'), null);
	assert.equal(parseAgentGatewayFileHref('agent-gateway://../secret'), null);
});

test('linkifies bare agent-gateway file URIs', () => {
	const root = parseMarkdown('Open agent-gateway://src/app.ts please', {
		markdownItPlugins: [agentGatewayLinkifyPlugin],
		markdownItOptions: { linkify: true }
	});
	const paragraph = root.children[0] as SvmdElementNode;
	const link = paragraph.children.find(
		(child): child is SvmdElementNode => child.kind === 'element' && child.name === 'a'
	);
	assert.ok(link);
	assert.equal(link.attrs.href, 'agent-gateway://src/app.ts');
});

test('parses Air-style markdown file links for preview', () => {
	const root = parseMarkdown('See [index.ts](agent-gateway://src/index.ts) and [my file.ts](agent-gateway://src/my%20file.ts)', {
		markdownItPlugins: [agentGatewayLinkifyPlugin],
		markdownItOptions: { linkify: true }
	});
	const paragraph = root.children[0] as SvmdElementNode;
	const links = paragraph.children.filter(
		(child): child is SvmdElementNode => child.kind === 'element' && child.name === 'a'
	);
	assert.equal(links.length, 2);
	assert.equal(links[0]?.attrs.href, 'agent-gateway://src/index.ts');
	assert.equal(parseAgentGatewayFileHref(String(links[0]?.attrs.href)), 'src/index.ts');
	assert.equal(links[1]?.attrs.href, 'agent-gateway://src/my%20file.ts');
	assert.equal(parseAgentGatewayFileHref(String(links[1]?.attrs.href)), 'src/my file.ts');
});

test('highlights registered languages and safely falls back to plaintext', () => {
	assert.equal(normalizeCodeLanguage('tsx'), 'typescript');
	assert.equal(normalizeCodeLanguage('unknown-agent-language'), 'plaintext');
	assert.equal(languageFromPath('src/app.ts'), 'typescript');
	assert.equal(languageFromPath('README'), 'plaintext');
	assert.match(highlightCode('const answer = 42', 'typescript'), /hljs-/);
	assert.equal(
		highlightCode('<script>alert(1)</script>', 'unknown'),
		'&lt;script&gt;alert(1)&lt;/script&gt;'
	);
});
