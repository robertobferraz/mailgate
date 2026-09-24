/* Captures the timeline page while a fresh demo run goes through approval, then builds a GIF with gifski. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

async function main(): Promise<void> {
  const base = process.env.API_URL ?? 'http://localhost:3000';
  const frames = mkdtempSync(join(tmpdir(), 'mailgate-timeline-'));

  const created = (await (
    await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'Hotel em SP (2 diárias)',
        amountCents: 84000,
        category: 'TRAVEL',
        requesterEmail: 'ana@acme.test',
        approverEmail: 'gestor@acme.test',
      }),
    })
  ).json()) as { id: string };

  try {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 600, height: 760 },
      });
      let n = 0;
      const shoot = async (count: number) => {
        for (let i = 0; i < count; i++) {
          await page.goto(`${base}/runs/${created.id}/timeline`);
          await page.screenshot({
            path: `${frames}/${String(n++).padStart(4, '0')}.png`,
          });
          await page.waitForTimeout(500);
        }
      };
      await shoot(8);
      execFileSync(
        'npx',
        ['ts-node', 'scripts/demo-reply.ts', 'pode aprovar'],
        {
          stdio: 'inherit',
        },
      );
      await shoot(12);
    } finally {
      await browser.close();
    }

    execFileSync(
      'bash',
      [
        '-c',
        `gifski --fps 2 --width 600 -o docs/assets/demo-timeline.gif ${frames}/*.png`,
      ],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
