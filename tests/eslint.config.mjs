import globals from 'globals';
export default [
  {
    files: ['target/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2021, puter: 'readonly', marked: 'readonly', DOMPurify: 'readonly', hljs: 'readonly', JSZip: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-dupe-class-members': 'error',
      'no-func-assign': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'warn',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^(el|esc|uid)$' }],
      'no-fallthrough': 'warn',
    },
  },
];
