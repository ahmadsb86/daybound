/*
 * Fuzzy matching for the resolve/delete/move pickers.
 *
 * Each word of the query is matched against the best-fitting *substring* of the title using
 * edit distance with transpositions (Sellers' algorithm, OSA variant). That makes it work when
 * you start typing from the middle of a name, and forgives one typo for words of 4-8 letters
 * (two for longer words). Short words (3 letters or fewer) must match exactly. As a last
 * resort a tight in-order subsequence ("mthhw" for "math hw") is accepted with a low score.
 */

export interface FuzzyResult {
  score: number;
  /** [start, end) character ranges in the original text to highlight */
  ranges: Array<[number, number]>;
}

const BOUNDARY = /[\s\-_/#.,:;()[\]]/;

function boundaryBonus(t: string, start: number): number {
  if (start === 0) return 15;
  return BOUNDARY.test(t[start - 1]) ? 10 : 0;
}

/** Best approximate occurrence of p inside t. */
export function approxSubstring(p: string, t: string): { dist: number; start: number; end: number } {
  const m = p.length;
  const n = t.length;
  let d2 = new Int32Array(n + 1);
  let s2 = new Int32Array(n + 1);
  let d1 = new Int32Array(n + 1);
  let s1 = new Int32Array(n + 1);
  let d0 = new Int32Array(n + 1);
  let s0 = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) {
    d1[j] = 0; // a match may start anywhere for free
    s1[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    d0[0] = i;
    s0[0] = 0;
    for (let j = 1; j <= n; j++) {
      const cost = p[i - 1] === t[j - 1] ? 0 : 1;
      let best = d1[j - 1] + cost;
      let bs = s1[j - 1];
      if (d1[j] + 1 < best) {
        best = d1[j] + 1;
        bs = s1[j];
      }
      if (d0[j - 1] + 1 < best) {
        best = d0[j - 1] + 1;
        bs = s0[j - 1];
      }
      if (i > 1 && j > 1 && p[i - 1] === t[j - 2] && p[i - 2] === t[j - 1] && d2[j - 2] + 1 < best) {
        best = d2[j - 2] + 1;
        bs = s2[j - 2];
      }
      d0[j] = best;
      s0[j] = bs;
    }
    [d2, d1, d0] = [d1, d0, d2];
    [s2, s1, s0] = [s1, s0, s2];
  }
  let bestDist = Infinity;
  let bestStart = 0;
  let bestEnd = 0;
  let bestBonus = -1;
  for (let j = 0; j <= n; j++) {
    const d = d1[j];
    const st = s1[j];
    const bonus = boundaryBonus(t, st);
    if (d < bestDist || (d === bestDist && (bonus > bestBonus || (bonus === bestBonus && st < bestStart)))) {
      bestDist = d;
      bestStart = st;
      bestEnd = j;
      bestBonus = bonus;
    }
  }
  return { dist: bestDist, start: bestStart, end: bestEnd };
}

function subsequence(p: string, t: string): { first: number; last: number } | null {
  let best: { first: number; last: number } | null = null;
  for (let s = t.indexOf(p[0]); s !== -1; s = t.indexOf(p[0], s + 1)) {
    let j = s;
    let ok = true;
    for (let i = 1; i < p.length; i++) {
      j = t.indexOf(p[i], j + 1);
      if (j === -1) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    if (!best || j - s < best.last - best.first) best = { first: s, last: j };
  }
  return best;
}

export function maxTypos(len: number): number {
  return len <= 3 ? 0 : len <= 8 ? 1 : 2;
}

function scoreWord(q: string, t: string): { score: number; range: [number, number] } | null {
  const a = approxSubstring(q, t);
  if (a.dist <= maxTypos(q.length)) {
    const score = 100 - a.dist * 30 + boundaryBonus(t, a.start) - Math.min(a.start, 50) * 0.2;
    return { score, range: [a.start, Math.max(a.end, a.start + 1)] };
  }
  if (q.length >= 2) {
    const sub = subsequence(q, t);
    if (sub) {
      const span = sub.last - sub.first + 1;
      if (span <= q.length * 3 + 2) {
        return { score: 40 - (span - q.length) * 2 + boundaryBonus(t, sub.first) / 3, range: [sub.first, sub.last + 1] };
      }
    }
  }
  return null;
}

function mergeRanges(r: Array<[number, number]>): Array<[number, number]> {
  const s = [...r].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

export function fuzzy(query: string, text: string): FuzzyResult | null {
  const t = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, ranges: [] };
  let total = 0;
  const ranges: Array<[number, number]> = [];
  for (const w of words) {
    const r = scoreWord(w, t);
    if (!r) return null;
    total += r.score;
    ranges.push(r.range);
  }
  if (words.length > 1 && t.includes(words.join(' '))) total += 20;
  return { score: total, ranges: mergeRanges(ranges) };
}
