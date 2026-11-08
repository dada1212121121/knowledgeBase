// ESLint 9 flat config:Vue SFC + TypeScript。
// <template> 由 vue-eslint-parser 解析,<script lang="ts"> 交给 @typescript-eslint/parser。
// 只开“能真正拦住 bug”的规则;格式类规则一律关掉(原型标记是逐字复刻的,不做排版检查)。
// 视觉基线相关的约束由 scripts/check-tokens.mjs 负责(见下文)。
import pluginVue from 'eslint-plugin-vue'
import tsParser from '@typescript-eslint/parser'
import vueParser from 'vue-eslint-parser'

const shared = {
  'vue/multi-word-component-names': 'off',
  'no-console': ['error', { allow: ['warn', 'error'] }],
  'no-debugger': 'error',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
  'vue/no-unused-components': 'error',
  'vue/no-unused-vars': 'error',
  'vue/require-v-for-key': 'error',
  'vue/no-mutating-props': 'error',
  'vue/no-side-effects-in-computed-properties': 'error',
  // 排版类:全部关闭
  'vue/attributes-order': 'off',
  'vue/max-attributes-per-line': 'off',
  'vue/singleline-html-element-content-newline': 'off',
  'vue/multiline-html-element-content-newline': 'off',
  'vue/html-self-closing': 'off',
  'vue/html-indent': 'off',
  'vue/html-closing-bracket-newline': 'off',
  'vue/html-closing-bracket-spacing': 'off',
  'vue/first-attribute-linebreak': 'off',
  'vue/html-quotes': 'off',
}

export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/pdfjs/**', 'e2e/shots/**', 'packages/kb-ui/src/tokens/**'] },
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: shared,
  },
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.js'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: shared,
  },
  {
    // 编辑器扩展示例():示例就是第三方扩展的样子,只能走公开入口 `@/editor/api`,
    // 不能 import 编辑器的其它模块(包括相对路径摸进去)或上游引擎 —— 否则示例教的就是一条走不通的路
    files: ['examples/**/*.{js,ts}', 'src/editor/extensions/examples/**/*.ts', 'src/editor/extensions/__fixtures__/overreach.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/editor/**', '!@/editor/api', '!@/editor/api/**', '**/editor/**', '!**/editor/api', '!**/editor/api/**', '**/editor/internal/**', '@betteroffice/*'],
              message: '扩展只能从 @/editor/api 导入（类型 + defineExtension）；不要依赖编辑器内部模块或上游引擎。',
            },
          ],
        },
      ],
    },
  },
  {
    // 脚本与 e2e:命令行工具本来就要往 stdout 打印结果
    files: ['e2e/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: { ...shared, 'no-console': 'off' },
  },
]
