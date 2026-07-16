// Minimal ESLint flat config for the SermonIndex node app (task 94).
//
// Deliberately DEPENDENCY-FREE so it loads even before any ESLint packages are
// installed — `npm run lint` only invokes ESLint when the binary is present.
//   Enable linting:     npm i -D eslint && npm run lint
//   Richer React rules: npm i -D eslint-plugin-react @eslint/js
//                       then import them here and extend this array.
//
// ESLint's built-in parser understands JSX via `ecmaFeatures.jsx`, so no extra
// parser/plugin is required for a basic syntax + dead-code pass.

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'warn',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'warn',
      'no-cond-assign': ['error', 'except-parens'],
    },
  },
  {
    // Never lint build output or dependencies.
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'server/**', 'scripts/**'],
  },
];
