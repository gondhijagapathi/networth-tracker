import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // `apps/web` is included for one file: the vault's cryptography. It has no DOM in it
    // — WebCrypto and the Argon2id WASM both run under Node — and it is the code the whole
    // zero-knowledge claim rests on, so it is tested as it ships rather than through a
    // mirror of itself.
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'apps/web/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'packages/*/src/**/*.ts',
        'apps/api/src/**/*.ts',
        'apps/web/src/lib/vaultCrypto.ts',
      ],
      exclude: ['**/*.test.ts', '**/__tests__/**'],
    },
  },
});
