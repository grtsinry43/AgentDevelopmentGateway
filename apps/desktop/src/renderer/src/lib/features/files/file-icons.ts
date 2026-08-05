/**
 * 文件类型 → VS Code 风格图标(iconify `@iconify-json/vscode-icons`)。
 *
 * 图标数据源是 vscode-icons 图标主题(1571 个图标),比手绘更全、可维护。
 * 这里只维护「文件名/扩展名 → 图标」的映射:
 *   - 精确文件名(BY_NAME)与文件名前缀(PREFIXES)
 *   - 扩展名(BY_EXTENSION)
 *   - 兜底分类:点文件(`.eslintrc`/`.npmrc`/`.gitignore` 这类)与 `.config.*`
 *     统一落到通用配置图标,不需要逐个枚举。
 * 未命中的返回 undefined,调用方回退通用文件图标。
 */

export type FileIconKind = string;

const BY_NAME: Record<string, string> = {
	'package.json': 'file-type-npm',
	'package-lock.json': 'file-type-npm',
	'jsconfig.json': 'file-type-jsconfig',
	'dockerfile': 'file-type-docker',
	'.dockerignore': 'file-type-docker',
	'.gitignore': 'file-type-git',
	'.gitattributes': 'file-type-git',
	'.gitmodules': 'file-type-git',
	'.editorconfig': 'file-type-editorconfig',
	'.npmrc': 'file-type-npm',
	'.nvmrc': 'file-type-node',
	'.node-version': 'file-type-node',
	'cargo.toml': 'file-type-cargo',
	'cargo.lock': 'file-type-cargo',
	'go.mod': 'file-type-go',
	'go.sum': 'file-type-go',
	'go.work': 'file-type-go',
	'pyproject.toml': 'file-type-pythonconfig',
	'pipfile': 'file-type-python',
	'gemfile': 'file-type-ruby',
	'rakefile': 'file-type-ruby',
	'gemfile.lock': 'file-type-ruby',
	'yarn.lock': 'file-type-yarn',
	'pnpm-lock.yaml': 'file-type-pnpm',
	'.gitlab-ci.yml': 'file-type-gitlab',
	'makefile': 'file-type-gnu',
	'gnumakefile': 'file-type-gnu',
	'cmakelists.txt': 'file-type-cmake',
	'build.gradle': 'file-type-gradle',
	'settings.gradle': 'file-type-gradle',
	'schema.prisma': 'file-type-prisma',
	'pom.xml': 'file-type-xml',
	'deno.json': 'file-type-deno',
	'deno.jsonc': 'file-type-deno',
	'readme': 'file-type-markdown',
	'readme.md': 'file-type-markdown',
	'license': 'file-type-license',
	'license.md': 'file-type-license',
	'licence': 'file-type-license',
	'copying': 'file-type-license'
};

const PREFIXES: Array<[string, string]> = [
	['tsconfig.', 'file-type-tsconfig-official'],
	['docker-compose.', 'file-type-docker'],
	['dockerfile.', 'file-type-docker'],
	['eslint.config.', 'file-type-eslint'],
	['prettier.config.', 'file-type-prettier'],
	['tailwind.config.', 'file-type-tailwind'],
	['vite.config.', 'file-type-vite'],
	['webpack.config.', 'file-type-webpack'],
	['jest.config.', 'file-type-jest'],
	['vitest.config.', 'file-type-vitest'],
	['playwright.config.', 'file-type-playwright'],
	['cypress.config.', 'file-type-cypress'],
	['prisma.config.', 'file-type-prisma'],
	['svelte.config.', 'file-type-svelteconfig'],
	['babel.config.', 'file-type-babel'],
	['postcss.config.', 'file-type-postcss'],
	['stylelint.config.', 'file-type-stylelint'],
	['commitlint.config.', 'file-type-commitlint'],
	['requirements.', 'file-type-python'],
	['.eslintrc', 'file-type-eslint'],
	['.prettierrc', 'file-type-prettier'],
	['.prettierignore', 'file-type-prettier'],
	['.babelrc', 'file-type-babel'],
	['.postcssrc', 'file-type-postcss'],
	['.stylelintrc', 'file-type-stylelint'],
	['.commitlintrc', 'file-type-commitlint'],
	['.env', 'file-type-dotenv']
];

const BY_EXTENSION: Record<string, string> = {
	ts: 'file-type-typescript',
	tsx: 'file-type-typescript',
	mts: 'file-type-typescript',
	cts: 'file-type-typescript',
	js: 'file-type-js',
	mjs: 'file-type-js',
	cjs: 'file-type-js',
	jsx: 'file-type-reactjs',
	rs: 'file-type-rust',
	c: 'file-type-c',
	h: 'file-type-c',
	cpp: 'file-type-cpp',
	cc: 'file-type-cpp',
	cxx: 'file-type-cpp',
	hpp: 'file-type-cppheader',
	hh: 'file-type-cppheader',
	hxx: 'file-type-cppheader',
	go: 'file-type-go',
	py: 'file-type-python',
	pyw: 'file-type-python',
	svelte: 'file-type-svelte',
	vue: 'file-type-vue',
	scss: 'file-type-scss',
	sass: 'file-type-sass',
	html: 'file-type-html',
	htm: 'file-type-html',
	css: 'file-type-css',
	md: 'file-type-markdown',
	mdx: 'file-type-markdown',
	markdown: 'file-type-markdown',
	sh: 'file-type-shell',
	bash: 'file-type-shell',
	zsh: 'file-type-shell',
	fish: 'file-type-shell',
	bat: 'file-type-bat',
	cmd: 'file-type-bat',
	ps1: 'file-type-powershell',
	psm1: 'file-type-powershell',
	json: 'file-type-json',
	jsonc: 'file-type-json',
	json5: 'file-type-json5',
	hjson: 'file-type-hjson',
	yml: 'file-type-yaml',
	yaml: 'file-type-yaml',
	toml: 'file-type-toml',
	xml: 'file-type-xml',
	ini: 'file-type-ini',
	cfg: 'file-type-ini',
	conf: 'file-type-ini',
	env: 'file-type-dotenv',
	sql: 'file-type-sql',
	java: 'file-type-java',
	php: 'file-type-php',
	rb: 'file-type-ruby',
	swift: 'file-type-swift',
	lua: 'file-type-lua',
	ex: 'file-type-elixir',
	exs: 'file-type-elixir',
	hs: 'file-type-haskell',
	zig: 'file-type-zig',
	kt: 'file-type-kotlin',
	kts: 'file-type-kotlin',
	scala: 'file-type-scala',
	cs: 'file-type-csharp',
	dart: 'file-type-dartlang',
	graphql: 'file-type-graphql',
	gql: 'file-type-graphql',
	astro: 'file-type-astro',
	lock: 'file-type-config',
	txt: 'file-type-text',
	log: 'file-type-log',
	license: 'file-type-license',
	org: 'file-type-org'
};

/** 按文件名/扩展名解析图标;无匹配返回 undefined(调用方回退通用文件图标)。 */
export function fileIconKindForName(name: string): FileIconKind | undefined {
	const base = basenameOf(name).toLowerCase();
	const exact = BY_NAME[base];
	if (exact) return exact;
	for (const [prefix, icon] of PREFIXES) {
		if (base.startsWith(prefix)) return icon;
	}
	const dot = base.lastIndexOf('.');
	const extension = dot > 0 ? base.slice(dot + 1) : '';
	const byExtension = BY_EXTENSION[extension];
	if (byExtension) return byExtension;
	if (base.startsWith('.')) return 'file-type-config';
	if (base.includes('.config.')) return 'file-type-config';
	return undefined;
}

function basenameOf(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const index = normalized.lastIndexOf('/');
	return index === -1 ? normalized : normalized.slice(index + 1);
}
