module.exports = {
  root: true,
  extends: 'airbnb-base',
  env: {
    browser: true,
  },
  parser: '@babel/eslint-parser',
  parserOptions: {
    allowImportExportEverywhere: true,
    sourceType: 'module',
    requireConfigFile: false,
  },
  rules: {
    'import/extensions': ['error', { js: 'always' }], // require js file extensions in imports
    'linebreak-style': ['error', 'unix'], // enforce unix linebreaks
    'no-param-reassign': [2, { props: false }], // allow modifying properties of param
  },
  overrides: [
    {
      files: ['static/delivery-planner/app.js'],
      rules: {
        // Single large module: order follows feature sections, not strict TDZ / Airbnb loop style.
        'no-use-before-define': ['error', { functions: false, allowNamedExports: true }],
        'no-plusplus': 'off',
        'no-await-in-loop': 'off',
        'no-promise-executor-return': 'off',
        'no-restricted-syntax': 'off',
        'no-underscore-dangle': 'off',
        'no-console': 'off',
        'no-alert': 'off',
        'no-empty': ['error', { allowEmptyCatch: true }],
      },
    },
  ],
};
