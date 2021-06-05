module.exports = {
  env: {
    node: true
  },
  extends: ['standard'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 11,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint'],
  rules: {
    'no-unused-vars': 'off',
    'no-redeclare': 'off',
    '@typescript-eslint/no-unused-vars': 'error',
    '@typescript-eslint/no-redeclare': 'error'
  }
}
