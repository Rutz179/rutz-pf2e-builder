/*
 * The skill audit's maths: plain data in and out (testable in node); rules.mjs gathers the data.
 * trainings need = automatic + level-1 free picks + one per Int rise ≤ L, have = trained on the sheet; increases need = class increases at 2..L + item ranks above trained, have = rank points above trained.
 * Recorded outside-build ranks (extraSkills) come off "have" first.
 */

/** Highest rank a skill increase can reach at this level. */
export function maxRankAt(level) {
  return level >= 15 ? 4 : level >= 7 ? 3 : 2;
}

const rankOf = v => Math.max(0, Math.min(4, Math.trunc(Number(v)) || 0));
const asMap = v => (v instanceof Map ? v : new Map(Array.isArray(v) ? v : Object.entries(v ?? {})));

/**
 * input { level, slugs, ranks, fixed: Map slug → [labels], slots: [{ key, label, n }], intLevels, increaseLevels, more: { n, list }, extras: [{ skill, from, to }], labels }
 * output { level, rows, train, inc, sources, open, lacking, unknown, over, excess, need, have, points }; rows[slug] { rank, sources, unknown, outside, records, surplus, over, fix }
 */
export function auditSkills({ level = 1, slugs = [], ranks = {}, fixed = [], slots = [], intLevels = [], increaseLevels = [], more = null, extras = [], labels = {} } = {}) {
  const L = Math.max(1, Math.trunc(Number(level)) || 1);
  const fixedMap = asMap(fixed);
  const intLabel = labels.int ?? (lv => `Int (Lv ${lv})`);
  const ints = [...new Set(intLevels.map(Number))].filter(lv => lv > 1 && lv <= L).sort((a, b) => a - b);
  const incs = [...new Set(increaseLevels.map(Number))].filter(lv => lv > 1 && lv <= L);
  const moreList = more?.list ?? [];

  // Free picks, in order: level-1 slots, then one per Intelligence rise.
  const free = [...slots.filter(x => x.n > 0).map(x => ({ ...x, left: x.n })), ...ints.map(lv => ({ key: "int-lv", label: intLabel(lv), n: 1, left: 1 }))];

  // Rank steps (1 = trained, 2 = expert …) a record says came from outside the build.
  const rows = {};
  for (const s of slugs) {
    const rank = rankOf(ranks[s]);
    const records = extras.filter(r => r?.skill === s);
    const steps = new Set();
    for (const r of records) for (let k = rankOf(r.from) + 1; k <= Math.min(rankOf(r.to), rank); k++) steps.add(k);
    let top = 0; // the highest rank the build itself has to explain
    for (let k = rank; k >= 1; k--) if (!steps.has(k)) { top = k; break; }
    rows[s] = {
      rank, records, outside: steps.size, top,
      trained: rank >= 1 && !steps.has(1),
      points: Math.max(0, rank - 1) - [...steps].filter(k => k >= 2).length,
      sources: [], unknown: false, surplus: false, over: false, fix: null
    };
  }

  // Trainings: automatic ones first, then free picks; whatever is left nothing explains.
  const unknown = [];
  const count = new Map();
  const tally = label => count.set(label, (count.get(label) ?? 0) + 1);
  // the source line lists automatic trainings first (in their order), then the free picks used
  for (const [s, labels] of fixedMap) if (rows[s]?.trained && labels.length) count.set(labels[0], 0);
  for (const s of slugs) {
    const row = rows[s];
    if (fixedMap.has(s)) row.sources = [...fixedMap.get(s)];
    if (!row.trained) continue;
    if (fixedMap.has(s)) { tally(row.sources[0]); continue; }
    const slot = free.find(x => x.left > 0);
    if (slot) { slot.left--; row.sources = [slot.label]; continue; }
    row.unknown = true;
    row.fix = { from: 0, to: row.rank };
    unknown.push(s);
  }
  const lacking = [...fixedMap.keys()].filter(s => slugs.includes(s) && (rows[s]?.rank ?? 0) < 1);
  const open = free.filter(x => x.left > 0).map(x => ({ key: x.key, label: x.label, n: x.left }));
  const trainNeed = fixedMap.size + free.reduce((n, x) => n + x.n, 0);
  const trainHave = slugs.filter(s => rows[s].trained).length;

  // Increases: the class's levels so far plus items' higher ranks, against rank points above trained.
  const incNeed = incs.length + (Number(more?.n) || 0);
  const incHave = slugs.reduce((n, s) => n + rows[s].points, 0);
  const incDiff = incHave - incNeed;

  // A rank the level doesn't allow yet (an item's own higher rank is allowed).
  const baseCap = incs.length ? maxRankAt(L) : 1;
  const over = [];
  for (const s of slugs) {
    const row = rows[s];
    const cap = Math.max(baseCap, ...moreList.filter(m => m.skill === s).map(m => Number(m.rank) || 0));
    row.cap = cap;
    if (row.top > cap) { row.over = true; over.push({ skill: s, rank: row.top, cap }); }
    // surplus increases: any skill above trained could be the one; offer its top ranks
    if ((incDiff > 0 && row.top >= 2) || row.over) {
      row.surplus = true;
      const from = Math.min(row.over ? cap : 4, incDiff > 0 ? Math.max(1, row.top - incDiff) : row.top);
      row.fix = { from: row.unknown ? 0 : from, to: row.rank };
    }
  }

  const train = { need: trainNeed, have: trainHave, diff: trainHave - trainNeed };
  const inc = { need: incNeed, have: incHave, diff: incDiff };
  return {
    level: L, rows, train, inc,
    sources: [...[...count].map(([label, n]) => ({ label, n })), ...free.filter(x => x.n > x.left).map(x => ({ label: x.label, n: x.n - x.left }))],
    open, lacking, unknown, over,
    // how much the sheet has that the build doesn't explain (the live notice compares before / after)
    excess: unknown.length + Math.max(0, incDiff) + over.length,
    need: trainNeed, have: trainHave,
    points: L > 1 ? { need: trainNeed + incNeed, have: trainHave + incHave } : null
  };
}
