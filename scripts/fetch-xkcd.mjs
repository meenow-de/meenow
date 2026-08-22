// Mirrors the current xkcd comic into the push relay repo, because xkcd's API
// sends no CORS headers and the app has no backend. Fail-soft: a stale mirror
// is fine and must never block the notification tick.
// Env: OUT_FILE (default xkcd.json), DRY_RUN=true to log without writing.
import { readFileSync, writeFileSync } from 'node:fs';

const OUT_FILE = process.env.OUT_FILE ?? 'xkcd.json';
const DRY_RUN = process.env.DRY_RUN === 'true';

try {
  const res = await fetch('https://xkcd.com/info.0.json');
  if (!res.ok) throw new Error(`xkcd API responded ${res.status}`);
  const data = await res.json();

  // Only the fields the card needs; the app re-validates everything on read.
  const mirror = {
    num: data.num,
    title: String(data.title ?? ''),
    img: String(data.img ?? ''),
    alt: String(data.alt ?? ''),
  };
  if (!Number.isInteger(mirror.num) || mirror.num <= 0 || !mirror.img.startsWith('https://imgs.xkcd.com/')) {
    throw new Error(`unexpected payload: ${JSON.stringify(mirror).slice(0, 200)}`);
  }

  const json = JSON.stringify(mirror, null, 2) + '\n';
  let existing = null;
  try { existing = readFileSync(OUT_FILE, 'utf8'); } catch { /* first run */ }
  if (existing === json) {
    console.log(`xkcd #${mirror.num} unchanged, not writing ${OUT_FILE}`);
  } else if (DRY_RUN) {
    console.log(`DRY_RUN: would write xkcd #${mirror.num} to ${OUT_FILE}`);
  } else {
    writeFileSync(OUT_FILE, json);
    console.log(`Wrote xkcd #${mirror.num} to ${OUT_FILE}`);
  }
} catch (err) {
  console.error(`xkcd mirror skipped: ${err.message}`);
}
