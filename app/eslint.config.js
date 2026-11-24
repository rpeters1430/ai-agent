'use strict';
// Lint config: catches real mistakes (undefined names, unreachable code, bad regexes, ...) without style rules.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off', // ANSI escape stripping is intentional
    },
  },
  {
    // Frontend: native ES modules (public/js/main.js is the entry). Every cross-file name is an explicit import, so
    // no-undef catches typos across files. xterm.js and its addons are classic scripts loaded first (globals).
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, Terminal: 'readonly', FitAddon: 'readonly', WebLinksAddon: 'readonly' } },
  },
];
