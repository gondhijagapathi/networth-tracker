/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'web',
        'api',
        'shared',
        'db',
        'auth',
        'vault',
        'nominee',
        'household',
        'prices',
        'backup',
        'docs',
        'ci',
        'deps',
        'repo',
      ],
    ],
  },
};
