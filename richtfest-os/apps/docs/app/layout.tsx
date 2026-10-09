import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import './global.css';

export const metadata: Metadata = {
  title: { default: 'Richtfest Docs', template: '%s · Richtfest Docs' },
  description: 'The operating guide for Richtfest, the AI-native construction planning workspace.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>
          <DocsLayout
            tree={source.getPageTree()}
            nav={{ title: 'Richtfest Docs', url: '/' }}
            searchToggle={{ enabled: false }}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
