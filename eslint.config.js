import eslint from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier'
import svelte from 'eslint-plugin-svelte'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      '**/.turbo/**',
      '.agents/**',
      'reference/**'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  prettier,
  ...svelte.configs['flat/prettier'],
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser
      }
    },
    rules: {
      // 键位只能走 shared/keymap 注册表(AGENTS.md 硬规则)。
      // 这条在下面的 renderer 专用块里以 no-restricted-syntax 强制。
      'svelte/no-at-html-tags': 'error'
    }
  },
  {
    // 渲染进程专用约束 —— 把 AGENTS.md 的硬规则做成可执行检查
    files: ['apps/desktop/src/renderer/**/*.{ts,svelte}'],
    ignores: ['apps/desktop/src/renderer/src/lib/shared/keymap/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^key(down|up|press)$/]",
          message:
            '键位注册只能通过 shared/keymap 的作用域栈,禁止散落的 keydown 监听(AGENTS.md)。'
        }
      ]
    }
  }
)
