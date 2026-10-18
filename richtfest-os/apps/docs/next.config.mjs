import { readFileSync, writeFileSync } from 'node:fs';
import { createMDX } from 'fumadocs-mdx/next';

// Generate before Fumadocs discovers pages, including direct Next.js/Docker builds.
const changelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
const unreleasedSections = [...changelog.matchAll(/^## Unreleased[^\S\r\n]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
if (process.env.REQUIRE_RELEASED_CHANGELOG === '1' && unreleasedSections.some((section) => section[1].trim())) {
  throw new Error('Production release blocked: move all Unreleased changelog entries to their verified Europe/Berlin release date before deploying.');
}

writeFileSync(new URL('./content/docs/changelog.md', import.meta.url), [
  '---',
  'title: Changelog',
  'description: Recent Richtfest product and platform updates.',
  '---',
  '',
  changelog.replace(/^# Changelog\r?\n\r?\n/, '').replace(/^## Unreleased[^\S\r\n]*\r?\n\s*(?=^## |$(?![\s\S]))/gm, ''),
].join('\n'));

const withMDX = createMDX();
export default withMDX({
  output: 'export',
  basePath: '/docs',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
});
