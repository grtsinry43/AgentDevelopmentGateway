import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

const LANGUAGE_ALIASES: Record<string, string> = {
	cjs: 'javascript',
	html: 'xml',
	js: 'javascript',
	jsx: 'javascript',
	md: 'markdown',
	mjs: 'javascript',
	py: 'python',
	rs: 'rust',
	sh: 'bash',
	shell: 'bash',
	svelte: 'xml',
	text: 'plaintext',
	ts: 'typescript',
	tsx: 'typescript',
	vue: 'xml',
	yml: 'yaml',
	zsh: 'bash'
};

export function normalizeCodeLanguage(value?: string): string {
	const requested =
		value
			?.trim()
			.toLowerCase()
			.replace(/^language-/, '') ?? '';
	const resolved = LANGUAGE_ALIASES[requested] ?? requested;
	return resolved && hljs.getLanguage(resolved) ? resolved : 'plaintext';
}

export function highlightCode(code: string, language?: string): string {
	return hljs.highlight(code, {
		language: normalizeCodeLanguage(language),
		ignoreIllegals: true
	}).value;
}
