/**
 * Reject npm / yarn installs without network access.
 *
 * Replaces the template's `npx --yes only-allow pnpm`, which needs the npm
 * cache and registry even when the workspace has no dependencies.
 */
const userAgent = process.env.npm_config_user_agent ?? ''

if (!userAgent.startsWith('pnpm/')) {
  console.error('This workspace only supports pnpm. Run `pnpm install` at the repository root.')
  process.exit(1)
}
