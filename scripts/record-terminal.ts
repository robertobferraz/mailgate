/* Runs scripts/demo-run.sh for real against the DEMO app, captures its stdout
 * line by line as it arrives, renders a terminal-looking HTML page for each
 * new line (held for a frame count proportional to the real gap before the
 * next line, so the 3s/4s sleeps in demo-run.sh still read as pauses), and
 * builds a GIF with gifski (D016: vhs was dropped — it could exit 0 without
 * ever writing a file; see docs/02-adr/0014-demo-gifs-recorded-with-playwright.md). */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { escapeHtml } from '../src/shared/html';

const FPS = 3;
const MIN_HOLD_FRAMES = 1;
const MAX_HOLD_FRAMES = 12; // caps any single gap at ~4s so a stall can't blow up the GIF

/** Pure: renders the terminal frame for a given transcript so far. */
export function renderTerminalHtml(lines: string[]): string {
  const body = lines
    .map((l) => `<div class="line">${escapeHtml(l) || '&nbsp;'}</div>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#0d1117;color:#c9d1d9;}
.term{padding:24px;white-space:pre-wrap;word-break:break-word;
  font-family:'SF Mono',Monaco,'Cascadia Code','Fira Code',monospace;
  font-size:16px;line-height:1.55;}
.line{min-height:1.55em;}
</style></head><body><div class="term">${body}</div></body></html>`;
}

async function main(): Promise<void> {
  const base = process.env.API_URL ?? 'http://localhost:3000';
  const frames = mkdtempSync(join(tmpdir(), 'mailgate-terminal-'));

  try {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 800, height: 500 },
      });
      let n = 0;
      const lines: string[] = [];
      const shoot = async () => {
        await page.setContent(renderTerminalHtml(lines));
        await page.screenshot({
          path: `${frames}/${String(n++).padStart(4, '0')}.png`,
        });
      };
      await shoot();

      const child = spawn('bash', ['scripts/demo-run.sh'], {
        env: { ...process.env, API_URL: base },
      });

      let buf = '';
      let lastT = Date.now();
      let chain: Promise<void> = Promise.resolve();

      const consume = async (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const now = Date.now();
          const holdFrames = Math.min(
            MAX_HOLD_FRAMES,
            Math.max(MIN_HOLD_FRAMES, Math.round(((now - lastT) / 1000) * FPS)),
          );
          lastT = now;
          for (let i = 0; i < holdFrames; i++) await shoot();
          lines.push(line);
          await shoot();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        chain = chain.then(() => consume(chunk));
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
      });
      await chain;
      if (exitCode !== 0) {
        throw new Error(`scripts/demo-run.sh exited ${exitCode}`);
      }

      for (let i = 0; i < FPS * 2; i++) await shoot(); // hold the final state briefly
    } finally {
      await browser.close();
    }

    execFileSync(
      'bash',
      [
        '-c',
        `gifski --fps ${FPS} --width 800 -o docs/assets/demo-terminal.gif ${frames}/*.png`,
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
