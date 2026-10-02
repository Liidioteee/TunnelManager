import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'out/**']
  },
  js.configs.recommended,
  {
    // main-процесс, библиотеки, тесты и конфиги — ES-модули под Node.js
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    // сквозные тесты: Node.js, плюс функции, которые выполняются в окне
    // приложения через page.evaluate и обращаются к document/window
    files: ['test-e2e/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  },
  {
    // CommonJS: preload (изолированный контекст окна) и надзиратель cloudflared
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node
    }
  },
  {
    // renderer — обычный скрипт страницы: браузерные глобальные объекты, без Node.js
    files: ['renderer.js', 'theme.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser
    }
  }
];
