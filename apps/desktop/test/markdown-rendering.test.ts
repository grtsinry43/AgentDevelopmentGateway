import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdown, type SvmdElementNode } from 'svmarkdown';
import {
	highlightCode,
	normalizeCodeLanguage
} from '../src/renderer/src/lib/features/session/markdown/highlight.js';
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

test('highlights registered languages and safely falls back to plaintext', () => {
	assert.equal(normalizeCodeLanguage('tsx'), 'typescript');
	assert.equal(normalizeCodeLanguage('unknown-agent-language'), 'plaintext');
	assert.match(highlightCode('const answer = 42', 'typescript'), /hljs-/);
	assert.equal(
		highlightCode('<script>alert(1)</script>', 'unknown'),
		'&lt;script&gt;alert(1)&lt;/script&gt;'
	);
});
