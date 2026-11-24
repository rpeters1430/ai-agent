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
    // Frontend: classic <script> files that share one global scope (app.js defines helpers the others use).
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, Terminal: 'readonly', FitAddon: 'readonly', WebLinksAddon: 'readonly', status: 'off' } }, // app.js declares its own `status`
    rules: {
      'no-undef': 'off',          // cross-file globals; `node --check` + the browser catch real typos
      'no-unused-vars': 'off',    // top-level functions are used from other files
      'no-redeclare': 'off',
    },
  },
];
