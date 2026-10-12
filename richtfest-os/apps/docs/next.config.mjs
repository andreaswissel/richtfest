import { readFileSync, writeFileSync } from 'node:fs';
import { createMDX } from 'fumadocs-mdx/next';

// Generate before Fumadocs discovers pages, including direct Next.js/Docker builds.
const changelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
writeFileSync(new URL('./content/docs/changelog.md', import.meta.url), [
  '---',
  'title: Changelog',
  'description: Recent Richtfest product and platform updates.',
  '---',
  '',
  changelog.replace(/^# Changelog\r?\n\r?\n/, ''),
].join('\n'));

const withMDX = createMDX();
export default withMDX({
  output: 'export',
  basePath: '/docs',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
});
