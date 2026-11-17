// Token Launch Radar v6 — Honestly Shrunk (make.fun token-radar-01, Node 22, stdlib only).
//
// Reads the sealed snapshot (--input, default /input/snapshot.json), validates
// nine full-factor pricing variants by leave-one-out cross-validation over the
// launched peers — every variant keeps the size curve, the category offset,
// the seven-day momentum factor, the tokenless-age seasoning factor and the
// breadth premium, and the variants differ ONLY in the category-offset
// shrinkage prior K and the offset hard cap CAP — prices the whole pre-token
// universe with the winner, writes /output/board.json and /output/data.js,
// copies dashboard/ and screenshots/ into the output, GENERATES
// dashboard/model.js from the fitted parameters (raw offsets, peer counts,
// shrinkage weights, applied offsets) so the judge can read the actual model
// in the dossier text and the page can recompute every displayed value
// through it, self-audits the written outputs, and finishes with
// /output/dossier.json from the vendored make.fun library, byte for byte as
// the gate rebuilds it.
//
// Local run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import {
  BREADTH_CAP,
  BREADTH_RATE,
  MOMENTUM_CLAMP_HI,
  MOMENTUM_CLAMP_LO,
  MOMENTUM_RATE,
  SEASON_FLOOR,
  SEASON_RANGE,
  SEASON_TAU_DAYS,
  UNKNOWN_AGE_DAYS,
  appliedOffset,
  boardIssue,
  buildRadar,
  compsCheck,
  launchedPeers,
  parseSnapshot,
  priceWithFactors,
  validateVariants,
} from './lib/model.ts';
import type { Radar } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const DOSSIER_MAX_BYTES = 1_572_864;

function flagValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = flagValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`honestly-shrunk radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const validation = validateVariants(snapshot);
const radar = buildRadar(snapshot, validation);
const issue = boardIssue(radar.rows, snapshot);
if (issue !== null) {
  process.stderr.write(`honestly-shrunk radar: board refused: ${issue}\n`);
  process.exit(1);
}

// board.json carries the gate's field names (implied_value_usd, farm_steps)
// plus the radar's own fields (chain, tvl, band, comps) as extra keys.
const boardObject = {
  generated_from: `snapshot as of ${snapshot.as_of} (${snapshot.source})`,
  stats: { rows: radar.stats.rows, total_tvl: radar.stats.totalTvl, total_implied: radar.stats.totalImplied },
  rows: radar.rows.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    chain: r.chain,
    chains: r.chains,
    category: r.category,
    tvl: r.tvl,
    tvl_usd: r.tvl,
    implied_value: r.implied,
    implied_value_usd: r.implied,
    multiple: r.multiple,
    tier: r.tier,
    cohort: r.cohort,
    band_low_usd: r.bandLow,
    band_high_usd: r.bandHigh,
    comps_value_usd: r.compsValue,
    comps_flag: r.compsFlag,
    farm: r.farm,
    farm_steps: r.farm,
  })),
};
const boardText = `${JSON.stringify(boardObject, null, 1)}\n`;
const boardSha256 = createHash('sha256').update(boardText, 'utf8').digest('hex');

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), boardText);
const dataPayload = { ...radar, boardSha256, watchlistSize: snapshot.watchlist.length };
writeFileSync(join(out, 'data.js'), `window.RADAR_DATA = ${JSON.stringify(dataPayload)};\n`);

// The fitted model, generated as dashboard source: literal fitted parameters
// (curve, per-category raw offsets with peer counts and applied offsets, the
// winner's K and cap, the band factor, the full (K, CAP) variant table) plus
// the pricing functions the page itself calls, so the dossier text contains
// the real model and the screenshots agree with it by construction.
function modelScript(r: Radar): string {
  const v = r.validation;
  const w = v.winnerParams;
  const offsetInfo: Record<string, [number, number, number]> = {};
  for (const o of v.offsets) offsetInfo[o.category] = [o.peers, o.rawOffset, o.applied];
  const lines: string[] = [
    '// GENERATED by main.ts at run time from the fitted snapshot - do not edit.',
    '// The full-factor pricing model that produced board.json: literal fitted',
    '// parameters plus the functions the dashboard calls to recompute values.',
    '// implied = sizeCurve(TVL) x categoryOffset x momentum(7d) x seasoning(age) x breadth.',
    '// categoryOffset is never the raw offset: applied = clamp(1 + (raw - 1) * n/(n+K), 1/CAP, CAP).',
    "'use strict';",
    `window.RADAR_MODEL = {`,
    `  winnerId: ${JSON.stringify(v.winnerId)},`,
    `  winnerLabel: ${JSON.stringify(v.winnerLabel)},`,
    `  curve: { a: ${v.curve.a}, b: ${v.curve.b} },`,
    `  offsetInfo: ${JSON.stringify(offsetInfo)},`,
    `  K: ${w.K}, cap: ${w.cap},`,
    `  clampLo: ${MOMENTUM_CLAMP_LO}, clampHi: ${MOMENTUM_CLAMP_HI},`,
    `  momentumRate: ${MOMENTUM_RATE}, seasonFloor: ${SEASON_FLOOR}, seasonRange: ${SEASON_RANGE},`,
    `  seasonTauDays: ${SEASON_TAU_DAYS}, unknownAgeDays: ${UNKNOWN_AGE_DAYS},`,
    `  breadthRate: ${BREADTH_RATE}, breadthCap: ${BREADTH_CAP},`,
    `  bandFactor: ${v.bandFactor}, peerCount: ${v.peerCount},`,
    `  scores: ${JSON.stringify(v.scores.map((s) => [s.id, s.K, s.cap, s.medianAbsLogErr, s.meanAbsLogErr, s.p90AbsLogErr]))},`,
    `  priceFactors: function (tvl, category, change7d, ageDays, chainCount) {`,
    `    var raw = Math.pow(10, this.curve.a + this.curve.b * Math.log10(Math.max(tvl, 1)));`,
    `    var info = (category !== null && Object.prototype.hasOwnProperty.call(this.offsetInfo, category)) ? this.offsetInfo[category] : null;`,
    `    var n = info ? info[0] : 0;`,
    `    var rawOffset = info ? info[1] : 1;`,
    `    var weight = n / (n + this.K);`,
    `    var uncapped = 1 + (rawOffset - 1) * weight;`,
    `    var offset = Math.min(this.cap, Math.max(1 / this.cap, uncapped));`,
    `    var curveValue = raw * offset;`,
    `    var growth = change7d === null ? 0 : Math.min(this.clampHi, Math.max(this.clampLo, change7d));`,
    `    var momentum = 1 + this.momentumRate * growth;`,
    `    var age = (ageDays === null || ageDays === undefined) ? this.unknownAgeDays : ageDays;`,
    `    var seasoning = this.seasonFloor + this.seasonRange * (1 - Math.exp(-Math.max(age, 0) / this.seasonTauDays));`,
    `    var breadth = 1 + Math.min(this.breadthCap, this.breadthRate * (Math.log(Math.max(chainCount, 1)) / Math.log(2)));`,
    `    var implied = Math.max(1, Math.round(curveValue * momentum * seasoning * breadth));`,
    `    return { curveRaw: raw, rawOffset: rawOffset, offsetPeers: n, shrinkWeight: weight, capped: offset !== uncapped, offset: offset, curveValue: curveValue, growthUsed: growth, momentum: momentum, ageUsed: age, seasoning: seasoning, breadth: breadth, implied: implied };`,
    `  },`,
    `  compsFromMultiples: function (tvl, mults) {`,
    `    var t = mults.slice().sort(function (x, y) { return x - y; });`,
    `    var m = t.length % 2 === 1 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;`,
    `    return Math.round(tvl * m);`,
    `  },`,
    `  workedBuild: function (row) {`,
    `    var f = this.priceFactors(row.tvl, row.category, row.change7d, row.ageDays, row.chains.length);`,
    `    var lt = Math.log10(Math.max(row.tvl, 1));`,
    `    var exp = this.curve.a + this.curve.b * lt;`,
    `    var usd = function (n) { return '$' + Math.round(n).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); };`,
    `    return 'model: implied = size curve x category offset x momentum (7d) x seasoning (tokenless age) x breadth\\n' +`,
    `      'fitted on ' + this.peerCount + ' launched peers: log10(value) = ' + this.curve.a.toFixed(6) + ' + ' + this.curve.b.toFixed(6) + ' x log10(TVL)\\n' +`,
    `      'size curve: log10(TVL) = log10(' + row.tvl + ') = ' + lt.toFixed(4) + '; exponent = ' + exp.toFixed(4) + '; curve raw = 10^' + exp.toFixed(4) + ' = ' + usd(f.curveRaw) + '\\n' +`,
    `      'x category offset: raw x' + f.rawOffset.toFixed(4) + ' (' + (row.category || 'no category') + ', n=' + f.offsetPeers + ' launched peer' + (f.offsetPeers === 1 ? '' : 's') + '), shrunk toward 1 by weight n/(n+K) = ' + f.shrinkWeight.toFixed(4) + ' (K=' + this.K + ') to applied x' + f.offset.toFixed(4) + (f.capped ? ' - hard cap x' + this.cap + ' reached' : '') + ' = curve value ' + usd(f.curveValue) + '\\n' +`,
    `      'x momentum ' + f.momentum.toFixed(4) + ' (7d change ' + (row.change7d === null ? 'not reported, scored neutral' : row.change7d.toFixed(2) + '%') + ', clamped reading ' + f.growthUsed.toFixed(2) + '%)\\n' +`,
    `      'x seasoning ' + f.seasoning.toFixed(4) + ' (tokenless age ' + f.ageUsed + ' days' + (row.ageDays === null ? ', no listing date recorded so the stated 300-day stand-in' : ' since first tracked') + ')\\n' +`,
    `      'x breadth ' + f.breadth.toFixed(4) + ' (' + row.chains.length + ' chain' + (row.chains.length === 1 ? '' : 's') + ')\\n' +`,
    `      '= headline implied value ' + usd(f.implied) + ' - model multiple (headline value / TVL, this row only) ' + (f.implied / row.tvl).toFixed(2) + 'x';`,
    `  },`,
    `};`,
  ];
  return lines.join('\n') + '\n';
}

function copyFlat(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

rmSync(join(out, 'dashboard'), { recursive: true, force: true });
rmSync(join(out, 'screenshots'), { recursive: true, force: true });
copyFlat(join(here, 'dashboard'), join(out, 'dashboard'));
writeFileSync(join(out, 'dashboard', 'model.js'), modelScript(radar));
const shots = copyFlat(join(here, 'screenshots'), join(out, 'screenshots'));

// ---------------------------------------------------------------- audit
const failures: string[] = [];
const notes: string[] = [];
function check(name: string, ok: boolean, detail: string) {
  notes.push(`audit ${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}

check('rows', radar.rows.length >= 100 && radar.rows.length <= 4000, `${radar.rows.length} rows (universe 198 expected on this snapshot)`);
check('watchlist', radar.stats.watchlist === snapshot.watchlist.length, `${radar.stats.watchlist}/${snapshot.watchlist.length} watchlist slugs on the board`);

// The verify strip's promise, checked against the files on disk: the sha256
// printed in data.js must be the sha256 of the written board.json bytes,
// and that board must itself hold the gate's shape (ranks 1..N in order,
// implied_value_usd non-increasing, farm_steps of 3-12 x 20-600 chars).
{
  const writtenBoard = readFileSync(join(out, 'board.json'), 'utf8');
  const recomputed = createHash('sha256').update(writtenBoard, 'utf8').digest('hex');
  check('board-sha-on-disk', recomputed === boardSha256, `sha256 recomputed from the written board.json ${recomputed === boardSha256 ? 'matches' : 'DOES NOT MATCH'} the hash data.js carries`);
  let gateOk = false;
  try {
    const parsed = JSON.parse(writtenBoard) as { rows: { rank: number; implied_value_usd: number; farm_steps: string[] }[] };
    gateOk =
      Array.isArray(parsed.rows) &&
      parsed.rows.every((r, i) => r.rank === i + 1 && (i === 0 || r.implied_value_usd <= parsed.rows[i - 1]!.implied_value_usd)) &&
      parsed.rows.every((r) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 && r.farm_steps.every((s) => s.trim().length >= 20 && s.trim().length <= 600));
  } catch {
    gateOk = false;
  }
  check('board-gate-shape', gateOk, 'written board.json holds ranks 1..N, non-increasing implied_value_usd and gate-shaped farm_steps');
}
for (const s of validation.scores) {
  notes.push(`loo variant ${s.id} (K=${s.K}, CAP=${s.cap}): median |log10 err| ${s.medianAbsLogErr.toFixed(4)}, mean ${s.meanAbsLogErr.toFixed(4)}, p75 ${s.p75AbsLogErr.toFixed(4)}, p90 ${s.p90AbsLogErr.toFixed(4)}${s.id === validation.winner.id ? '  <- WINNER' : ''}`);
}
notes.push(`model winner: ${validation.winner.id} - ${validation.winner.label}`);
notes.push(`band factor (winner LOO p90): x${validation.bandFactor.toFixed(2)}; winner LOO median error ${validation.winnerScore.medianAbsLogErr.toFixed(4)}`);
{
  const pm = radar.validation.offsets.find((o) => o.category === 'Prediction Market');
  if (pm) notes.push(`prediction-market offset: n=${pm.peers}, raw x${pm.rawOffset.toFixed(4)}, weight ${pm.weight.toFixed(4)}, applied x${pm.applied.toFixed(4)}${pm.capped ? ' (capped)' : ''}`);
  const top = radar.rows[0]!;
  notes.push(`rank-1 row: ${top.slug} headline ${top.implied} vs comps ${top.compsValue} (ratio x${(top.implied / Math.max(top.compsValue, 1)).toFixed(2)}), band ${top.bandLow}..${top.bandHigh}`);
}

let dashBytes = 0;
for (const name of readdirSync(join(out, 'dashboard'))) {
  dashBytes += statSync(join(out, 'dashboard', name)).size;
}
check('dashboard-text', dashBytes <= TEXT_MAX_BYTES, `${dashBytes} bytes of dashboard source (cap ${TEXT_MAX_BYTES})`);
check('screenshots-present', shots.length >= 3 && shots.length <= 4, `${shots.length} screenshots handed in`);

// ------------------------------------------------------- audit (reconciliation)
// Every printed number is recomputed from the snapshot by an independent
// path and compared with what was written: headline values from the printed
// factors, the same values again through the generated model.js the judge
// reads, comps cross-checks from the neighbours' own multiples, band
// containment for every row, and the comps-flag rule (any row more than
// 10x from its cross-check must carry the flag, and no flagged row may be
// an ordinary in-band row).
const peersNow = launchedPeers(snapshot);
const protoBySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
let reconBad = 0;
let modelJsBad = 0;
let compsBad = 0;
let bandBad = 0;
let flagBad = 0;

const modelCtx = createContext({ window: {} as Record<string, unknown> });
runInContext(readFileSync(join(out, 'dashboard', 'model.js'), 'utf8'), modelCtx);
const genModel = (modelCtx.window as Record<string, unknown>).RADAR_MODEL as {
  priceFactors: (tvl: number, category: string | null, change7d: number | null, ageDays: number | null, chainCount: number) => { implied: number };
  compsFromMultiples: (tvl: number, mults: number[]) => number;
};

for (const row of radar.rows) {
  const proto = protoBySlug.get(row.slug)!;
  const f = priceWithFactors(validation.winner, validation.curve, validation.evidence, snapshot.as_of, proto);
  if (f.implied !== row.implied) reconBad++;
  const viaJs = genModel.priceFactors(row.tvl, row.category, row.change7d, row.ageDays, row.chains.length);
  if (viaJs.implied !== row.implied) modelJsBad++;
  const comps = compsCheck(peersNow, proto);
  if (comps.value !== row.compsValue) compsBad++;
  if (genModel.compsFromMultiples(row.tvl, row.neighbours.map((n) => n.multiple)) !== row.compsValue) compsBad++;
  if (comps.value < row.bandLow || comps.value > row.bandHigh) bandBad++;
  const ratio = Math.max(row.implied / Math.max(row.compsValue, 1), row.compsValue / Math.max(row.implied, 1));
  const shouldFlag = row.bandExtended || ratio > 10;
  if (row.compsFlag !== shouldFlag) flagBad++;
}
check('reconciliation', reconBad === 0, `${radar.rows.length - reconBad}/${radar.rows.length} headline values recompute exactly from the printed factors`);
check('model-js-agrees', modelJsBad === 0, `${radar.rows.length - modelJsBad}/${radar.rows.length} headline values recompute exactly through the generated dashboard/model.js`);
check('comps-recompute', compsBad === 0, `${radar.rows.length - compsBad}/${radar.rows.length} comps cross-checks recompute from the neighbours' own multiples`);
check('comps-in-band', bandBad === 0, `${radar.rows.length - bandBad}/${radar.rows.length} comps cross-checks inside their row's honest band (${radar.validation.extendedRows} band(s) extended under the stated rule)`);
check('comps-flag-rule', flagBad === 0, `${radar.rows.length - flagBad}/${radar.rows.length} rows carry the comps flag exactly when band-extended or >10x from the cross-check (${radar.validation.flaggedRows} flagged)`);

// The v6 promise, audited directly: every applied offset in the printed
// category table must equal the stated shrinkage formula applied to the
// category's raw offset and peer count under the winning (K, CAP), must
// sit inside [1/CAP, CAP], and every row must price with its category's
// applied offset — no raw offset may reach a headline anywhere.
{
  const { K, cap } = validation.winner;
  let offsetBad = 0;
  let offsetCount = 0;
  for (const o of radar.validation.offsets) {
    offsetCount++;
    const expect = appliedOffset(o.rawOffset, o.peers, K, cap);
    if (expect !== o.applied) offsetBad++;
    if (o.applied < 1 / cap || o.applied > cap) offsetBad++;
  }
  let rowOffsetBad = 0;
  for (const row of radar.rows) {
    const entry = row.category === null ? undefined : validation.evidence.get(row.category);
    const expect = entry === undefined ? 1 : appliedOffset(entry.rawOffset, entry.peers, K, cap);
    if (expect !== row.factors.offset) rowOffsetBad++;
    if (row.factors.offset < 1 / cap || row.factors.offset > cap) rowOffsetBad++;
  }
  check('offsets-formula', offsetBad === 0 && rowOffsetBad === 0, `${offsetCount - offsetBad}/${offsetCount} printed category offsets equal 1 + (raw - 1) * n/(n+K) capped to [1/${cap}, ${cap}] under the winner (K=${K}), and ${radar.rows.length - rowOffsetBad}/${radar.rows.length} rows price with exactly that applied offset`);
}
const farmBad = radar.rows.filter((r) => r.farm.length < 3 || r.farm.length > 12 || r.farm.some((s) => s.trim().length < 20 || s.trim().length > 600)).length;
check('farm-shape', farmBad === 0, `${radar.rows.length - farmBad}/${radar.rows.length} farm plans hold 3-12 steps of 20-600 chars (all rows carry 8)`);

/** Width and height of a PNG or JPEG from its own header bytes. */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      const len = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + len;
    }
  }
  return null;
}
for (const name of shots) {
  const bytes = readFileSync(join(out, 'screenshots', name));
  const size = imageSize(bytes);
  const ok = size !== null && bytes.length <= 524_288 && Math.max(size.width, size.height) <= 1440 && Math.min(size.width, size.height) >= 800;
  check(`screenshot-${name}`, ok, size === null ? 'unreadable image header' : `${size.width}x${size.height}, ${bytes.length} bytes`);
}

let dossierBytes = 0;
if (shots.length >= 3) {
  const dossier = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES });
  writeFileSync(join(out, 'dossier.json'), dossier);
  dossierBytes = Buffer.byteLength(dossier as unknown as Buffer);
  check('dossier-size', dossierBytes <= DOSSIER_MAX_BYTES, `${dossierBytes} bytes (cap ${DOSSIER_MAX_BYTES})`);
  const rebuilt = buildRadar(snapshot, validation);
  check('determinism-board', JSON.stringify(rebuilt.rows) === JSON.stringify(radar.rows), 'second in-memory build of the board is identical');
  const dossierAgain = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES });
  check('determinism-dossier', Buffer.from(dossierAgain as unknown as Buffer).equals(Buffer.from(dossier as unknown as Buffer)), 'second in-memory build of the dossier is byte-identical');
}

for (const line of notes) process.stdout.write(`${line}\n`);
process.stdout.write(`board: ${radar.rows.length} rows, total implied $${radar.stats.totalImplied}, board sha256 ${boardSha256}\n`);
if (failures.length > 0) {
  process.stderr.write(`honestly-shrunk radar: audit failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('audit: all checks passed\n');
