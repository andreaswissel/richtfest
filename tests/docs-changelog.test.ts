import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('docs release gate rejects pending notes, permits local review, and omits empty queues', () => {
  const root = mkdtempSync(join(tmpdir(), 'richtfest-changelog-'));
  const docs = join(root, 'richtfest-os/apps/docs');
  const generated = join(docs, 'content/docs/changelog.md');
  mkdirSync(join(docs, 'content/docs'), { recursive: true });
  copyFileSync(resolve('richtfest-os/apps/docs/next.config.mjs'), join(docs, 'next.config.mjs'));
  symlinkSync(resolve('richtfest-os/apps/docs/node_modules'), join(docs, 'node_modules'), 'dir');

  try {
    const released = '## 2026-10-16\n\n- Shipped change.\n';
    const cases = [
      { notes: `## Unreleased\n\n- Pending change.\n\n${released}`, gate: '1', allowed: false },
      { notes: '## Unreleased\n\n- Pending at end of file.', gate: '1', allowed: false },
      { notes: `## Unreleased\n\n${released}\n## Unreleased\n\n- Second queue.`, gate: '1', allowed: false },
      { notes: `## Unreleased\n\n- Pending change.\n\n${released}`, gate: '', allowed: true },
      { notes: `## Unreleased\n\n${released}`, gate: '1', allowed: true },
      { notes: `## Unreleased\r\n\r\n${released.replaceAll('\n', '\r\n')}`, gate: '1', allowed: true },
      { notes: released, gate: '1', allowed: true },
    ];
    for (const { notes, gate, allowed } of cases) {
      rmSync(generated, { force: true });
      writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n${notes}`);
      const result = spawnSync('node', ['next.config.mjs'], {
        cwd: docs,
        env: { ...process.env, REQUIRE_RELEASED_CHANGELOG: gate },
        encoding: 'utf8',
      });
      if (!allowed) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Production release blocked');
        expect(existsSync(generated)).toBe(false);
      } else {
        expect(result.status, result.stderr).toBe(0);
        const output = readFileSync(generated, 'utf8').replaceAll('\r\n', '\n');
        expect(output).toContain(released);
        if (gate === '1') expect(output).not.toContain('## Unreleased');
        else expect(output).toContain('- Pending change.');
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
