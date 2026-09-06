/**
 * `drizzle-kit` is a generator, not a runtime dependency — it is fetched on demand by
 * `npm run db:generate` rather than carried in the lockfile (its stale `@esbuild-kit`
 * tree pulls in an advisory-flagged esbuild). The SQL it produces is committed under
 * `migrations/` and applied on boot by `src/db/migrate.ts`, so a fresh clone needs
 * nothing beyond the runtime dependencies.
 *
 * The config is a plain object rather than `defineConfig(...)` precisely so it can be
 * read without `drizzle-kit` being installed locally.
 *
 * @type {import('drizzle-kit').Config}
 */
export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
  casing: 'snake_case',
};
