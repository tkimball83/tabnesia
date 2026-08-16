export default [
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        browser: 'readonly',
        document: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        setTimeout: 'readonly',
        setImmediate: 'readonly',
        structuredClone: 'readonly',
        Blob: 'readonly',
        globalThis: 'writable',
      },
    },
  },
  {
    ignores: ['web-ext-artifacts/'],
  },
];
