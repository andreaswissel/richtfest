import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();
export default withMDX({
  output: 'export',
  basePath: '/docs',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
});
