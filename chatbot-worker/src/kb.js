// Knowledge-base loading. The Worker fetches the live kb-index.json from the
// static site on every cold isolate / cache expiry — a knowledge refresh is
// just `git push` (re-running tools/build_kb.py), no `wrangler deploy` needed.
// A bundled copy (built at deploy time) is the offline fallback if the fetch
// ever fails.
import kbBundled from "../../kb/kb-index.json";

const KB_URL = "https://abhishekyogi24-hue.github.io/kb/kb-index.json";
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

let memoChunks = null;
let memoAt = 0;

export async function loadKB() {
  const now = Date.now();
  if (memoChunks && now - memoAt < REFRESH_MS) return memoChunks;

  try {
    const res = await fetch(KB_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.chunks) && data.chunks.length) {
        memoChunks = data.chunks;
        memoAt = now;
        return memoChunks;
      }
    }
  } catch (e) {
    // network/parse error — fall through to whatever we have
  }

  if (memoChunks) return memoChunks; // stale-but-served beats nothing
  memoChunks = kbBundled.chunks;
  memoAt = now;
  return memoChunks;
}

export function bundledVersion() {
  return kbBundled.version || "bundled";
}
