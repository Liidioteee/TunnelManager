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
    // preload выполняется в изолированном контексте и подключается как CommonJS
    files: ['preload.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node
    }
  },
  {
    // renderer — обычный скрипт страницы: браузерные глобальные объекты, без Node.js
    files: ['renderer.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser
    }
  }
];
