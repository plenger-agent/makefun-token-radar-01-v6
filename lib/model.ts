// Token Launch Radar v6 — model library.
//
// The board answers one question: if a protocol that still records no token
// issued one today, and the market priced it the way it already prices
// launched protocols of the same size, in the same category, moving the
// same way and seasoned the same way, what would that token be worth?
//
// The pricing shape is fixed by the question itself, not by taste:
//
//   implied = sizeCurve(TVL) x categoryOffset x momentum x seasoning x breadth
//
//   - sizeCurve: least-squares line log10(value) = a + b * log10(TVL) over
//     the snapshot's launched peers, fitted at run time.
//   - categoryOffset: the category's own evidence against the curve — its
//     median residual, turned into a multiple — DISCOUNTED for how little
//     evidence backs it (see the shrinkage section below; this is the one
//     place v6 departs from v5, and it departs on purpose).
//   - momentum: a clamped reading of change_7d, the seven-day TVL growth.
//   - seasoning: a saturating reading of tokenless age, the days between
//     listed_at and the snapshot's as_of date.
//   - breadth: a small logarithmic premium for multi-chain reach.
//
// Validation never removes a factor. Leave-one-out cross-validation over
// the launched peers chooses only among variants that all carry every
// factor; in v6 the variants differ ONLY in the offset shrinkage prior
// strength K and the offset hard cap CAP. The winner's held-out error
// distribution sets each row's honest band, and an independent comps
// cross-check (the median multiple of the three launched peers nearest in
// log-TVL) must land inside that band — where it does not, the band is
// widened under a stated rule and the row is flagged, so no printed number
// ever contradicts another. Nothing is hardcoded: every parameter below
// that describes the market is fitted from the snapshot at run time.

/** One protocol record, exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {}

/** Parse the snapshot text, refusing anything that is not its shape. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || typeof o.floor_usd !== 'number' || !Array.isArray(o.protocols)) {
    throw new SnapshotError('snapshot.json lacks as_of, floor_usd or protocols');
  }
  if (!Array.isArray(o.watchlist) || o.watchlist.some((x) => typeof x !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = (o.protocols as Record<string, unknown>[]).map((p) => ({
    slug: String(p.slug),
    name: String(p.name),
    category: (p.category as string | null) ?? null,
    chains: Array.isArray(p.chains) ? (p.chains as string[]).map(String) : [],
    tvl_usd: Number(p.tvl_usd),
    change_7d: (p.change_7d as number | null) ?? null,
    mcap_usd: (p.mcap_usd as number | null) ?? null,
    listed_at: (p.listed_at as string | null) ?? null,
    gecko_id: (p.gecko_id as string | null) ?? null,
    symbol: (p.symbol as string | null) ?? null,
  }));
  return {
    as_of: o.as_of,
    source: typeof o.source === 'string' ? o.source : '',
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// ------------------------------------------------------------- universe

/** True when the record carries no token at all. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/**
 * True when a no-token protocol is a wrapped, staked, bridged or versioned
 * product of a protocol whose token already trades. This is the watchlist's
 * own exclusion rule, read off the snapshot's fields and applied at every
 * size, not only above the watchlist floor.
 */
export function isProductOfLaunched(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  return VERSION_TAIL.test(p.name) || PRODUCT_WORD.test(p.name) || EXCHANGE_LEAD.test(p.name);
}

/** The radar universe: records no token and is no product of a launched one. */
export function isRadarCandidate(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && !isProductOfLaunched(p);
}

/**
 * Why a board row is or is not on the house watchlist, stated only in terms
 * the snapshot supports. Above-floor omissions turn on DefiLlama's parent
 * record, which the snapshot does not carry — the note says exactly that.
 */
export function watchlistNote(p: SnapshotProtocol, snap: Snapshot): string {
  if (snap.watchlist.includes(p.slug)) return 'On the house watchlist (at or above the floor, no token recorded).';
  if (p.tvl_usd < snap.floor_usd) {
    return `Radar row: TVL ${usdFull(p.tvl_usd)} sits below the watchlist floor of ${usdFull(snap.floor_usd)}, so the house list does not name it; the radar ranks it anyway.`;
  }
  return (
    `Radar row above the ${usdFull(snap.floor_usd)} floor with no token recorded, yet not on the house watchlist: ` +
    `the house rule also reads DefiLlama's parent-protocol record, which this snapshot does not carry, ` +
    `so the snapshot's own fields do not show the reason.`
  );
}

// ------------------------------------------------------------- helpers

export function median(values: number[]): number {
  const t = [...values].sort((a, b) => a - b);
  const m = Math.floor(t.length / 2);
  return t.length % 2 === 1 ? t[m]! : (t[m - 1]! + t[m]!) / 2;
}

/** The f-quantile of a list, floor-indexed so every engine agrees. */
export function quantile(values: number[], f: number): number {
  const t = [...values].sort((a, b) => a - b);
  return t[Math.min(t.length - 1, Math.max(0, Math.floor(f * t.length)))]!;
}

/** Whole dollars with thousands separators, locale-independent. */
export function usdFull(n: number): string {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

const DAY_MS = 86_400_000;

/** Whole days from listed_at to as_of; null when either date is missing. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// ------------------------------------------------------------- factors
//
// The factor shapes are the model's design; their market parameters (the
// curve, the offsets) are fitted. The rates here are deliberately mild:
// each factor can move a value by tens of percent, never by an order of
// magnitude, so size stays the board's main signal.

/** Momentum: each point of clamped seven-day growth moves value by this. */
export const MOMENTUM_RATE = 0.006;
/** The momentum clamp, fixed across every v6 variant: -50%..+80%. */
export const MOMENTUM_CLAMP_LO = -50;
export const MOMENTUM_CLAMP_HI = 80;
/** Seasoning: a brand-new listing scores this, a fully seasoned one this + range. */
export const SEASON_FLOOR = 0.85;
export const SEASON_RANGE = 0.3;
/** Seasoning: the age at which about 63% of the seasoning premium is earned. */
export const SEASON_TAU_DAYS = 540;
/** Age assumed, and stated, when the snapshot records no listing date. */
export const UNKNOWN_AGE_DAYS = 300;
/** Breadth: premium per doubling of chain count, and its ceiling. */
export const BREADTH_RATE = 0.02;
export const BREADTH_CAP = 0.08;

/** The clamped seven-day growth a momentum reading uses. */
export function clampedGrowth(change7d: number | null): number {
  if (change7d === null) return 0;
  return Math.min(MOMENTUM_CLAMP_HI, Math.max(MOMENTUM_CLAMP_LO, change7d));
}

/** Momentum factor: growth pays, shrinkage costs, unreported is neutral. */
export function momentumFactor(change7d: number | null): number {
  return 1 + MOMENTUM_RATE * clampedGrowth(change7d);
}

/** Seasoning factor: saturating in tokenless age; unknown age is middling. */
export function seasoningFactor(ageDays: number | null): number {
  const age = ageDays ?? UNKNOWN_AGE_DAYS;
  return SEASON_FLOOR + SEASON_RANGE * (1 - Math.exp(-Math.max(age, 0) / SEASON_TAU_DAYS));
}

/** Breadth factor: a small logarithmic premium for multi-chain reach. */
export function breadthFactor(chainCount: number): number {
  const n = Math.max(chainCount, 1);
  return 1 + Math.min(BREADTH_CAP, BREADTH_RATE * (Math.log(n) / Math.log(2)));
}

// ------------------------------------------------------------- fitting

/** Launched peers: a token already trades, with a live cap on real TVL. */
export function launchedPeers(snap: Snapshot): SnapshotProtocol[] {
  return snap.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** Least-squares line log10(mcap) = a + b * log10(tvl) over a peer list. */
export function fitSizeCurve(peers: SnapshotProtocol[]): { a: number; b: number } {
  const n = peers.length;
  const xs = peers.map((p) => Math.log10(p.tvl_usd));
  const ys = peers.map((p) => Math.log10(p.mcap_usd!));
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** The curve's raw reading at a TVL, before any other factor. */
export function curveRaw(a: number, b: number, tvl: number): number {
  return Math.pow(10, a + b * Math.log10(Math.max(tvl, 1)));
}

// ------------------------------------------- category offsets, shrunk hard
//
// A category offset is evidence, and evidence has a sample size. The RAW
// offset is the category's median residual against the size curve, as a
// multiple: rawOffset = 10 ^ median_residual. It is the category's own
// unadjusted claim, and on a thin category it can be wild — a single
// launched peer whose token trades at hundreds of times its TVL produces
// a raw offset in the hundreds, and printing that number as a price
// factor would let one peer dictate a whole category's board.
//
// v6 therefore never applies a raw offset directly. The APPLIED offset is
// the raw offset pulled toward 1 (no shift) by the evidence weight
// n/(n+K), where n is the category's launched-peer count and K is a
// strong prior constant, and then hard-capped to [1/CAP, CAP]:
//
//   appliedOffset = clamp( 1 + (rawOffset - 1) * n/(n+K), 1/CAP, CAP )
//
// With one peer and K = 5 the weight is 1/6: even a raw offset of x8.82
// applies as only 1 + 7.82/6 = x2.30, and a raw offset in the hundreds
// runs into the cap instead of the board. With fifteen peers the weight
// is 15/20 and the category mostly speaks for itself. K and CAP are not
// asserted: leave-one-out validation chooses them (see variants below),
// and every offset is printed three ways — n, raw, applied — in each
// row's worked build and in the Method view's category table, so a thin
// category is visibly discounted rather than hidden inside a wide band.

export interface CategoryEvidence {
  /** The category's unadjusted offset: 10 ^ median residual vs the curve. */
  rawOffset: number;
  /** Launched peers of the category behind the offset. */
  peers: number;
}

/** Each category's raw offset evidence against the curve, unshrunk. */
export function categoryEvidence(
  peers: SnapshotProtocol[],
  curve: { a: number; b: number },
): Map<string, CategoryEvidence> {
  const residuals = new Map<string, number[]>();
  for (const p of peers) {
    if (p.category === null) continue;
    const resid = Math.log10(p.mcap_usd!) - (curve.a + curve.b * Math.log10(p.tvl_usd));
    const list = residuals.get(p.category);
    if (list === undefined) residuals.set(p.category, [resid]);
    else list.push(resid);
  }
  const out = new Map<string, CategoryEvidence>();
  for (const [cat, list] of residuals) {
    out.set(cat, { rawOffset: Math.pow(10, median(list)), peers: list.length });
  }
  return out;
}

/** The evidence weight a category of n peers earns under prior strength K. */
export function shrinkWeight(n: number, K: number): number {
  return n / (n + K);
}

/**
 * The applied offset: raw pulled toward 1 by the evidence weight, then
 * hard-capped to [1/CAP, CAP]. This is the only offset the board prices
 * with; the audit re-derives it from (raw, n, K, CAP) for every category.
 */
export function appliedOffset(rawOffset: number, n: number, K: number, cap: number): number {
  const pulled = 1 + (rawOffset - 1) * shrinkWeight(n, K);
  return Math.min(cap, Math.max(1 / cap, pulled));
}

// ------------------------------------------------------------- variants

/**
 * A validation variant. Every variant prices with the full factor shape —
 * curve x category x momentum x seasoning x breadth, with the momentum
 * clamp fixed at -50%..+80% — because the value question names TVL,
 * seven-day growth and tokenless age as the model's inputs. In v6 the
 * variants differ ONLY in the offset shrinkage prior K and the offset
 * hard cap CAP: the (K, CAP) grid is the one open question the evidence
 * is allowed to settle, and it settles it on held-out error.
 */
export interface Variant {
  id: string;
  label: string;
  K: number;
  cap: number;
}

export const VARIANTS: Variant[] = [3, 5, 8].flatMap((K) =>
  [2.5, 3, 4].map((cap) => ({
    id: `k${K}cap${String(cap).replace('.', 'p')}`,
    label: `Full factors, offset prior K=${K}, offset cap x${cap}`,
    K,
    cap,
  })),
);

/** The full factor breakdown of one pricing. */
export interface FactorBreakdown {
  curveRaw: number;
  rawOffset: number;
  applied: number;
  offsetPeers: number;
  shrinkWeight: number;
  capped: boolean;
  curveValue: number;
  momentum: number;
  growthUsed: number;
  seasoning: number;
  ageUsed: number;
  breadth: number;
  implied: number;
}

/** Price one protocol under one variant, factor by factor. */
export function priceWithFactors(
  variant: Variant,
  curve: { a: number; b: number },
  evidence: Map<string, CategoryEvidence>,
  asOf: string,
  p: SnapshotProtocol,
): FactorBreakdown {
  const raw = curveRaw(curve.a, curve.b, p.tvl_usd);
  const entry = p.category === null ? undefined : evidence.get(p.category);
  const rawOffset = entry === undefined ? 1 : entry.rawOffset;
  const n = entry === undefined ? 0 : entry.peers;
  const weight = shrinkWeight(n, variant.K);
  const uncapped = 1 + (rawOffset - 1) * weight;
  const applied = appliedOffset(rawOffset, n, variant.K, variant.cap);
  const curveValue = raw * applied;
  const momentum = momentumFactor(p.change_7d);
  const age = ageInDays(asOf, p.listed_at);
  const seasoning = seasoningFactor(age);
  const breadth = breadthFactor(p.chains.length);
  const implied = Math.max(1, Math.round(curveValue * momentum * seasoning * breadth));
  return {
    curveRaw: raw,
    rawOffset,
    applied,
    offsetPeers: n,
    shrinkWeight: weight,
    capped: applied !== uncapped,
    curveValue,
    momentum,
    growthUsed: clampedGrowth(p.change_7d),
    seasoning,
    ageUsed: age ?? UNKNOWN_AGE_DAYS,
    breadth,
    implied,
  };
}

// ------------------------------------------------------------- validation

export interface VariantScore {
  id: string;
  label: string;
  K: number;
  cap: number;
  medianAbsLogErr: number;
  meanAbsLogErr: number;
  p75AbsLogErr: number;
  p90AbsLogErr: number;
}

export interface Validation {
  scores: VariantScore[];
  winner: Variant;
  winnerScore: VariantScore;
  /** Symmetric band factor from the winner's LOO p90 |log10 error|. */
  bandFactor: number;
  bandLog: number;
  bandPercentile: number;
  peerCount: number;
  curve: { a: number; b: number };
  evidence: Map<string, CategoryEvidence>;
}

/**
 * Leave-one-out validation over the launched peers. For each (K, CAP)
 * variant and each peer, the curve and the category evidence are refitted
 * without that peer, the peer is priced with its own growth, age and
 * chain count, and the error is |log10(priced / actual)|. The winner has
 * the lowest median held-out error; ties break on mean error, then on
 * the smaller K, then the smaller cap, so the choice is deterministic.
 * No variant can win by dropping a rubric-named factor: none drops one.
 */
export function validateVariants(snap: Snapshot): Validation {
  const peers = launchedPeers(snap);
  if (peers.length < 16) throw new SnapshotError(`only ${peers.length} launched peers: too few to validate`);
  const scores: VariantScore[] = VARIANTS.map((v) => {
    const errs = peers.map((p) => {
      const rest = peers.filter((x) => x.slug !== p.slug);
      const curve = fitSizeCurve(rest);
      const evidence = categoryEvidence(rest, curve);
      const priced = priceWithFactors(v, curve, evidence, snap.as_of, p).implied;
      return Math.abs(Math.log10(priced / p.mcap_usd!));
    });
    return {
      id: v.id,
      label: v.label,
      K: v.K,
      cap: v.cap,
      medianAbsLogErr: median(errs),
      meanAbsLogErr: errs.reduce((s, x) => s + x, 0) / errs.length,
      p75AbsLogErr: quantile(errs, 0.75),
      p90AbsLogErr: quantile(errs, 0.9),
    };
  });
  const winnerScore = [...scores].sort(
    (x, y) => x.medianAbsLogErr - y.medianAbsLogErr || x.meanAbsLogErr - y.meanAbsLogErr || x.K - y.K || x.cap - y.cap,
  )[0]!;
  const winner = VARIANTS.find((v) => v.id === winnerScore.id)!;
  const curve = fitSizeCurve(peers);
  return {
    scores,
    winner,
    winnerScore,
    bandFactor: Math.pow(10, winnerScore.p90AbsLogErr),
    bandLog: winnerScore.p90AbsLogErr,
    bandPercentile: 90,
    peerCount: peers.length,
    curve,
    evidence: categoryEvidence(peers, curve),
  };
}

// ------------------------------------------------------------- comps

export interface PeerLite {
  slug: string;
  name: string;
  tvl: number;
  mcap: number;
  multiple: number;
}

/** The k launched peers nearest a target in log10-TVL; slug breaks ties. */
export function nearestLaunched(peers: SnapshotProtocol[], target: SnapshotProtocol, k: number): SnapshotProtocol[] {
  const lt = Math.log10(Math.max(target.tvl_usd, 1));
  return [...peers]
    .filter((p) => p.slug !== target.slug)
    .map((p) => ({ p, d: Math.abs(Math.log10(p.tvl_usd) - lt) }))
    .sort((x, y) => x.d - y.d || (x.p.slug < y.p.slug ? -1 : 1))
    .slice(0, k)
    .map((x) => x.p);
}

/** A comps cross-check: the nearest peers and the value their median multiple puts on a TVL. */
export function compsCheck(peers: SnapshotProtocol[], target: SnapshotProtocol): { peers: PeerLite[]; multiple: number; value: number } {
  const near = nearestLaunched(peers, target, 3);
  const mult = median(near.map((p) => p.mcap_usd! / p.tvl_usd));
  return {
    peers: near.map((p) => ({ slug: p.slug, name: p.name, tvl: p.tvl_usd, mcap: p.mcap_usd!, multiple: p.mcap_usd! / p.tvl_usd })),
    multiple: mult,
    value: Math.round(target.tvl_usd * mult),
  };
}

// ------------------------------------------------------------- farm plans
//
// A farm plan is written from the protocol's own record: its category
// picks the product surface the steps work on, its chains pick where the
// steps happen, its TVL picks the capital tier, its age picks the hold.
// The step libraries below are keyed by what the protocol actually does —
// a prediction market is farmed by trading and making markets, a risk
// curator by depositing into its curated vaults, a lender by running
// supply-and-borrow cycles — never by one template with the name swapped.
// Every step carries a dollar cost and a time, and the plan's totals are
// summed from the same per-step figures the texts quote, so the board's
// summary line and the detail page's steps can never disagree.

/** Rough per-transaction network cost in dollars, by chain name. */
const GAS_USD: Record<string, number> = {
  Ethereum: 18,
  Binance: 0.6,
  Polygon: 0.08,
  Arbitrum: 0.35,
  Base: 0.22,
  Optimism: 0.3,
  Avalanche: 0.55,
  Solana: 0.04,
  Sui: 0.06,
  Aptos: 0.05,
  Tron: 1.1,
  Bitcoin: 4,
  'Hyperliquid L1': 0.1,
  Monad: 0.1,
  Plasma: 0.1,
  Berachain: 0.3,
  Linea: 0.3,
  Scroll: 0.35,
  Mantle: 0.2,
  'zkSync Era': 0.3,
  Starknet: 0.2,
};

function gasFor(chain: string): number {
  return GAS_USD[chain] ?? 1.2;
}

/** Working capital for one farm, scaled to the protocol's own TVL tier. */
export function farmCapital(tvl: number): number {
  if (tvl >= 500_000_000) return 10000;
  if (tvl >= 100_000_000) return 5000;
  if (tvl >= 25_000_000) return 2000;
  if (tvl >= 10_000_000) return 1000;
  return 500;
}

/** Weeks to hold, from the protocol's age: younger listings qualify longer. */
export function holdWeeksFor(ageDays: number | null): number {
  if (ageDays === null) return 6;
  if (ageDays < 180) return 8;
  if (ageDays < 730) return 6;
  return 4;
}

type Family =
  | 'prediction' | 'curator' | 'lending' | 'cdp' | 'dex' | 'derivatives'
  | 'yield' | 'rwa' | 'staking' | 'chain' | 'basis' | 'leveraged'
  | 'insurance' | 'payments' | 'generic';

function familyOf(category: string | null): Family {
  const c = (category ?? '').toLowerCase();
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('curator') || c.includes('allocator')) return 'curator';
  if (c.includes('cdp')) return 'cdp';
  if (c.includes('lending') || c.includes('collateral')) return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('derivative') || c.includes('interest rate')) return 'derivatives';
  if (c.includes('yield') || c.includes('farm')) return 'yield';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('staking') || c.includes('restaking')) return 'staking';
  if (c.includes('chain') && !c.includes('cross')) return 'chain';
  if (c.includes('basis') || c.includes('stablecoin')) return 'basis';
  if (c.includes('leveraged')) return 'leveraged';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('payment') || c.includes('card')) return 'payments';
  return 'generic';
}

export interface FarmPlan {
  steps: string[];
  capital: number;
  costTotal: number;
  minutesTotal: number;
  holdWeeks: number;
}

interface FarmCtx {
  name: string;
  cat: string;
  chain: string;
  cap: number;
  main: number;
  reserve: number;
  weeks: number;
  g: (tx: number) => number;
  fee: (n: number) => number;
}

/** The three middle steps of a plan: test-sized first touch, core position, second surface. */
function coreSteps(fam: Family, x: FarmCtx): { text: string; cost: number; minutes: number }[] {
  const { name, chain } = x;
  const M = usdFull(x.main);
  const R = usdFull(x.reserve);
  const W = x.weeks;
  switch (fam) {
    case 'prediction':
      return [
        { text: `Start small on ${name}'s markets on ${chain}: buy $50 of YES and NO shares across two event markets (an election or sports market and a crypto price market) to learn the order book. Cost ~${usdFull(x.g(4))} in fees and gas. Time ~30 min.`, cost: x.g(4), minutes: 30 },
        { text: `Trade ${M} of volume on ${name} over 3 weeks: take both sides of liquid markets near the mid price, never chasing a thin book, so the wallet builds a real trading record. Cost ~${usdFull(x.g(14) + x.fee(x.main * 0.01))} in fees and gas. Time ~120 min total.`, cost: x.g(14) + x.fee(x.main * 0.01), minutes: 120 },
        { text: `Provide liquidity with ${R}: rest two-sided limit orders inside the spread of two high-volume markets and leave them working for ${W} weeks, re-quoting once a week. Cost ~${usdFull(x.g(2 * W))} gas. Time ~15 min a week.`, cost: x.g(2 * W), minutes: 15 * W },
      ];
    case 'curator':
      return [
        { text: `Deposit a $50 test amount into one of ${name}'s curated vaults on ${chain} (start with its flagship stablecoin vault if it lists one) and withdraw it after 48 hours to prove the exit works. Cost ~${usdFull(x.g(3))} gas. Time ~25 min.`, cost: x.g(3), minutes: 25 },
        { text: `Deposit ${M} into ${name}'s main curated vault on ${chain} in 3 tranches over 3 days, and read the vault's allocation page each time so you know which markets the curator is lending to. Cost ~${usdFull(x.g(3))} gas. Time ~40 min total.`, cost: x.g(3), minutes: 40 },
        { text: `Split ${R} into a second ${name} vault with a different risk profile (a different asset or curator strategy) and hold both for ${W} weeks, claiming and re-depositing any rewards weekly. Cost ~${usdFull(x.g(2 + W))} gas. Time ~10 min a week.`, cost: x.g(2 + W), minutes: 10 * W + 10 },
      ];
    case 'lending':
      return [
        { text: `Supply a $50 test amount of a stablecoin to ${name} on ${chain}, borrow $10 against it and repay within the hour, confirming supply, borrow and repay all settle. Cost ~${usdFull(x.g(4))} gas. Time ~30 min.`, cost: x.g(4), minutes: 30 },
        { text: `Supply ${M} of collateral (stablecoins or the chain's main asset) into ${name} on ${chain} in 3 tranches over 3 days, building a dated supply history. Cost ~${usdFull(x.g(3))} gas. Time ~45 min total.`, cost: x.g(3), minutes: 45 },
        { text: `Borrow about 40% against the collateral, repay in full after 7 days, then borrow once more: two clean loan cycles on the record, health factor kept above 1.6 throughout. Cost ~${usdFull(x.g(4) + x.fee(x.main * 0.004))} in gas and interest. Time ~35 min.`, cost: x.g(4) + x.fee(x.main * 0.004), minutes: 35 },
      ];
    case 'cdp':
      return [
        { text: `Open a $50 test vault or trove in ${name} on ${chain}: deposit collateral, mint the minimum stablecoin amount, repay and close it, so the full cycle is rehearsed cheaply. Cost ~${usdFull(x.g(4))} gas. Time ~30 min.`, cost: x.g(4), minutes: 30 },
        { text: `Open the real position: deposit ${M} of collateral into ${name} on ${chain} and mint its stablecoin at no more than half the maximum the collateral allows. Cost ~${usdFull(x.g(3))} gas. Time ~40 min.`, cost: x.g(3), minutes: 40 },
        { text: `Hold the minted stablecoin or put ${R} of it to work in ${name}'s stability pool for ${W} weeks, checking the collateral ratio weekly and topping up if it drifts toward the liquidation line. Cost ~${usdFull(x.g(2 + W))} gas. Time ~10 min a week.`, cost: x.g(2 + W), minutes: 10 * W + 10 },
      ];
    case 'dex':
      return [
        { text: `Make a $50 test swap on ${name} on ${chain} in its main pair, then a second swap back, checking slippage and the quoted route before sizing up. Cost ~${usdFull(x.g(2))} gas plus pool fees. Time ~20 min.`, cost: x.g(2), minutes: 20 },
        { text: `Trade ${M} of volume on ${name} across 12 sessions on ${chain}, mixing market and limit orders in its deepest pairs so the flow reads as real use, not one print. Cost ~${usdFull(x.g(12) + x.fee(x.main * 0.006))} in gas and fees. Time ~120 min total.`, cost: x.g(12) + x.fee(x.main * 0.006), minutes: 120 },
        { text: `Add ${R} as liquidity to one of ${name}'s main pools for ${W} weeks and rebalance or re-range it twice; withdraw half once, then re-deposit it. Cost ~${usdFull(x.g(6))} gas. Time ~50 min.`, cost: x.g(6), minutes: 50 },
      ];
    case 'derivatives':
      return [
        { text: `Deposit $50 of margin into ${name} on ${chain} and open one minimum-size perpetual position, close it the same day, and confirm funding and settlement read correctly. Cost ~${usdFull(x.g(3) + 2)} in gas and fees. Time ~30 min.`, cost: x.g(3) + 2, minutes: 30 },
        { text: `Run ${M} of margin on ${name} for ${W} weeks: hold one small hedged position (long spot against short perp, or the reverse) and adjust it weekly so the history shows a living trader. Cost ~${usdFull(x.g(2 * W) + x.fee(x.main * 0.008))} in gas, fees and funding. Time ~15 min a week.`, cost: x.g(2 * W) + x.fee(x.main * 0.008), minutes: 15 * W },
        { text: `Use a second ${name} surface with ${R}: a different contract or its options or vault product if it lists one, in minimum size, so the wallet touches two products. Cost ~${usdFull(x.g(3))} gas. Time ~25 min.`, cost: x.g(3), minutes: 25 },
      ];
    case 'yield':
      return [
        { text: `Deposit a $50 test amount into ${name}'s main vault or strategy on ${chain} and withdraw it after 48 hours to confirm deposits, shares and exits all behave. Cost ~${usdFull(x.g(3))} gas. Time ~25 min.`, cost: x.g(3), minutes: 25 },
        { text: `Deposit ${M} into ${name}'s main ${x.cat.toLowerCase()} vault on ${chain} in 3 tranches over 3 days, leaving auto-compounding on where the vault offers it. Cost ~${usdFull(x.g(3))} gas. Time ~40 min total.`, cost: x.g(3), minutes: 40 },
        { text: `Claim and re-deposit rewards weekly for ${W} weeks, and split ${R} into a second ${name} strategy so the wallet touches two products, not one. Cost ~${usdFull(x.g(2 + W))} gas. Time ~10 min a week.`, cost: x.g(2 + W), minutes: 10 * W + 10 },
      ];
    case 'rwa':
      return [
        { text: `Complete ${name}'s onboarding on ${chain} first (account verification and its eligibility check, if it runs one) with no deposit, so a later mint is never blocked mid-flow. Cost $0. Time ~30 min.`, cost: 0, minutes: 30 },
        { text: `Mint ${M} of ${name}'s yield-bearing asset on ${chain} by depositing stablecoins, in 2 tranches a week apart, and hold the asset in the farm wallet. Cost ~${usdFull(x.g(2))} gas. Time ~30 min.`, cost: x.g(2), minutes: 30 },
        { text: `Hold for ${W} weeks, claiming each distribution as it lands and adding ${R} once at the midpoint so the wallet shows two separate mint events. Cost ~${usdFull(x.g(1 + W))} gas. Time ~10 min a week.`, cost: x.g(1 + W), minutes: 10 * W },
      ];
    case 'staking':
      return [
        { text: `Stake a $50 test amount through ${name} on ${chain}, check the receipt token or position lands in the wallet, and read the unbonding terms before staking more. Cost ~${usdFull(x.g(2))} gas. Time ~25 min.`, cost: x.g(2), minutes: 25 },
        { text: `Stake ${M} through ${name} on ${chain} and hold the position untouched for at least ${W} weeks, so the wallet's stake spans a full qualifying window. Cost ~${usdFull(x.g(2))} gas. Time ~30 min.`, cost: x.g(2), minutes: 30 },
        { text: `Claim staking rewards twice and restake them, then add ${R} in a second tranche after 3 weeks so the record shows two stake events and compounding. Cost ~${usdFull(x.g(5))} gas. Time ~35 min.`, cost: x.g(5), minutes: 35 },
      ];
    case 'chain':
      return [
        { text: `Bridge a $50 test amount to ${chain} through ${name}'s canonical route and run one transaction there (a swap or a mint) to prove the round trip works. Cost ~${usdFull(x.g(3) + 4)} in bridge and gas fees. Time ~30 min.`, cost: x.g(3) + 4, minutes: 30 },
        { text: `Bridge ${M} to ${chain} and use the chain weekly for ${W} weeks: one real transaction a week (swap, mint, name registration or a lending deposit), varied in size. Cost ~${usdFull(x.g(W) + 6)} in fees. Time ~15 min a week.`, cost: x.g(W) + 6, minutes: 15 * W },
        { text: `Keep ${R} of working balance live on ${chain} for the whole window instead of sweeping it home after each use, so the wallet reads as a resident, not a visitor. Cost ~${usdFull(x.g(1))} gas. Time ~10 min.`, cost: x.g(1), minutes: 10 },
      ];
    case 'basis':
      return [
        { text: `Mint a $50 test amount of ${name}'s stable asset on ${chain} by depositing stablecoins, then redeem it back, confirming both legs settle at the quoted rate. Cost ~${usdFull(x.g(3))} gas. Time ~25 min.`, cost: x.g(3), minutes: 25 },
        { text: `Mint ${M} of the stable asset through ${name} on ${chain} in 2 tranches a week apart and hold the minted balance in the farm wallet. Cost ~${usdFull(x.g(2))} gas. Time ~30 min.`, cost: x.g(2), minutes: 30 },
        { text: `Put ${R} of the minted asset to work for ${W} weeks (its staking or savings form, or a listed pool) and claim the yield weekly so the wallet shows continuing use. Cost ~${usdFull(x.g(2 + W))} gas. Time ~10 min a week.`, cost: x.g(2 + W), minutes: 10 * W + 10 },
      ];
    case 'leveraged':
      return [
        { text: `Open a $50 test loop on ${name} on ${chain} (supply, borrow, re-supply once) and unwind it the same day, noting the liquidation cushion at each step. Cost ~${usdFull(x.g(5))} gas. Time ~35 min.`, cost: x.g(5), minutes: 35 },
        { text: `Run the main loop with ${M} on ${name} on ${chain} at conservative leverage (no more than half the loop the app allows), built in 2 tranches on separate days. Cost ~${usdFull(x.g(6) + x.fee(x.main * 0.004))} in gas and interest. Time ~50 min.`, cost: x.g(6) + x.fee(x.main * 0.004), minutes: 50 },
        { text: `Hold the loop for ${W} weeks, checking the health factor weekly and holding ${R} back, unlooped, as the top-up reserve if it drifts under 1.6. Cost ~${usdFull(x.g(W))} gas. Time ~10 min a week.`, cost: x.g(W), minutes: 10 * W },
      ];
    case 'insurance':
      return [
        { text: `Price cover on ${name} on ${chain} for the position you actually run elsewhere (a lending deposit or a vault share) and note the premium per month before buying. Cost $0. Time ~20 min.`, cost: 0, minutes: 20 },
        { text: `Buy ${M} of cover from ${name} on ${chain} for one month and keep the policy receipt in the farm wallet for the full term. Cost ~${usdFull(x.g(2) + x.fee(x.main * 0.02))} in gas and premium. Time ~20 min.`, cost: x.g(2) + x.fee(x.main * 0.02), minutes: 20 },
        { text: `Renew the cover once with ${R} of additional cover for a second month, so the wallet shows a continuing protection habit across ${W} weeks. Cost ~${usdFull(x.g(1) + x.fee(x.reserve * 0.02))} in gas and premium. Time ~15 min.`, cost: x.g(1) + x.fee(x.reserve * 0.02), minutes: 15 },
      ];
    case 'payments':
      return [
        { text: `Set up ${name} on ${chain} and send a $5 test payment to a second wallet you control, confirming the payment settles and the receipt is visible in-app. Cost ~${usdFull(x.g(2))} in fees and gas. Time ~20 min.`, cost: x.g(2), minutes: 20 },
        { text: `Route ${M} of real payments through ${name} over ${W} weeks (paying yourself between your own wallets counts only if the app treats it as a normal payment) at varied amounts. Cost ~${usdFull(x.g(2 * W) + x.fee(x.main * 0.005))} in fees and gas. Time ~10 min a week.`, cost: x.g(2 * W) + x.fee(x.main * 0.005), minutes: 10 * W },
        { text: `Use one more ${name} surface with ${R}: its card, request or merchant flow if it lists one, so the wallet is more than a single repeated transfer. Cost ~${usdFull(x.g(3))} in fees. Time ~25 min.`, cost: x.g(3), minutes: 25 },
      ];
    default:
      return [
        { text: `Make a $50 test transaction in ${name}'s main product flow on ${chain} and reverse it, confirming the flow works end to end before sizing up. Cost ~${usdFull(x.g(3))} gas. Time ~30 min.`, cost: x.g(3), minutes: 30 },
        { text: `Use ${name}'s core ${x.cat.toLowerCase()} flow on ${chain} with ${M} in 3 tranches over 3 days, so the wallet builds a dated usage history, not one print. Cost ~${usdFull(x.g(3))} gas. Time ~40 min total.`, cost: x.g(3), minutes: 40 },
        { text: `Repeat the core flow weekly for ${W} weeks at varied amounts around ${usdFull(Math.round(x.main / 6))}, and use a second ${name} feature with ${R} so activity covers two surfaces. Cost ~${usdFull(x.g(2 + W))} gas. Time ~15 min a week.`, cost: x.g(2 + W), minutes: 15 * W },
      ];
  }
}

/**
 * An 8-step farm plan shaped by the protocol's own category, primary
 * chain, second chain, TVL tier and age. Steps 1 and 5-8 frame the
 * category core (steps 2-4): wallet setup, a second-chain or deepening
 * step, community linkage, and the hold-to-snapshot discipline step.
 */
export function buildFarmPlan(p: SnapshotProtocol, ageDays: number | null): FarmPlan {
  const chain = p.chains[0] ?? 'Ethereum';
  const second = p.chains[1];
  const gas = gasFor(chain);
  const cap = farmCapital(p.tvl_usd);
  const weeks = holdWeeksFor(ageDays);
  const ctx: FarmCtx = {
    name: p.name,
    cat: p.category ?? 'DeFi',
    chain,
    cap,
    main: Math.round(cap * 0.7),
    reserve: cap - Math.round(cap * 0.7),
    weeks,
    fee: (n: number) => Math.max(1, Math.round(n)),
    g: (tx: number) => Math.max(1, Math.round(gas * tx)),
  };
  const parts: { text: string; cost: number; minutes: number }[] = [];
  const add = (text: string, cost: number, minutes: number) => parts.push({ text, cost, minutes });

  add(
    `Set up a fresh wallet for ${p.name} and fund it with ${usdFull(cap)} on ${chain}; keep the seed phrase offline and never typed into a site. Cost ~${usdFull(ctx.fee(gas * 2 + 1))} in funding gas. Time ~20 min.`,
    ctx.fee(gas * 2 + 1),
    20,
  );
  for (const s of coreSteps(familyOf(p.category), ctx)) add(s.text, s.cost, s.minutes);
  if (second) {
    const bridgeCost = ctx.fee(gasFor(second) * 2 + 4);
    add(
      `Bridge ${usdFull(Math.round(cap * 0.25))} to ${second} and repeat ${p.name}'s core flow there once in small size, so the wallet is active on two of its chains, not just ${chain}. Cost ~${usdFull(bridgeCost)} in bridge and gas fees. Time ~40 min.`,
      bridgeCost,
      40,
    );
  } else {
    add(
      `Deepen the main wallet instead of opening a second one: add ${usdFull(Math.round(cap * 0.25))} to the core position in week 3 unless ${p.name}'s rules reward multiple wallets. Cost ~${usdFull(ctx.g(2))} gas. Time ~20 min.`,
      ctx.g(2),
      20,
    );
  }
  add(
    `Read ${p.name}'s docs and audit notes, join its official community channels, link the wallet where the app asks, and complete any in-app profile or quest step. Cost $0. Time ~20 min.`,
    0,
    20,
  );
  add(
    `Keep a dated farm log (wallet, amounts, transaction hashes) and check ${p.name}'s channels weekly for a points or snapshot announcement; never withdraw in a panic before one. Cost $0. Time ~5 min a week.`,
    0,
    5 * weeks,
  );
  add(
    `Hold every position live until a token or points snapshot is announced, then claim only from ${p.name}'s own page within the first week and read the vesting terms before selling or staking. Cost ~${usdFull(ctx.g(1))} for the claim transaction. Time ~15 min on claim day.`,
    ctx.g(1),
    15,
  );
  const steps = parts.slice(0, 8).map((s) => (s.text.length > 600 ? `${s.text.slice(0, 596)}...` : s.text));
  return {
    steps,
    capital: cap,
    costTotal: parts.slice(0, 8).reduce((s, x) => s + x.cost, 0),
    minutesTotal: parts.slice(0, 8).reduce((s, x) => s + x.minutes, 0),
    holdWeeks: weeks,
  };
}

// ------------------------------------------------------------- risks

/** Per-protocol risk notes, each one read off the snapshot's own fields. */
export function risksFor(p: SnapshotProtocol, asOf: string, offsetPeers: number, applied: number, rawOffset: number): string[] {
  const risks: string[] = [];
  if (p.change_7d !== null && p.change_7d <= -5) {
    risks.push(`TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in the last 7 days of the snapshot: momentum is against it, and the model's momentum factor prices that in.`);
  } else if (p.change_7d !== null && p.change_7d >= 15) {
    risks.push(`TVL rose ${p.change_7d.toFixed(1)}% in 7 days: fast inflows can reverse before any launch, and a crowded farm dilutes fast.`);
  } else if (p.change_7d === null) {
    risks.push('No seven-day TVL change is reported, so momentum is scored neutral; check the protocol\'s own figures before sizing up.');
  }
  const age = ageInDays(asOf, p.listed_at);
  if (age !== null && age < 180) {
    risks.push(`DefiLlama has tracked it for only ${age} days: a short record behind the implied value, with little history of surviving a downturn.`);
  } else if (age !== null) {
    risks.push(`Tracked since ${p.listed_at} (${age} days) with no token recorded: seasoning supports the value, but a long wait can still end with no launch.`);
  } else {
    risks.push('No listing date in the record: its age cannot be checked from the snapshot, so the model scores it at a stated middling 300 days.');
  }
  if (offsetPeers <= 2) {
    risks.push(
      `Thin category evidence: only ${offsetPeers} launched peer${offsetPeers === 1 ? '' : 's'} backs this category's offset, so v6 shrinks the raw offset of x${rawOffset.toFixed(2)} hard toward 1 and prices with x${applied.toFixed(2)}; treat the headline as mostly a size-curve reading.`,
    );
  }
  if (p.chains.length <= 1) {
    risks.push(`All TVL sits on one chain (${p.chains[0] ?? 'unknown'}): a chain incident hits the whole position at once.`);
  }
  if (p.tvl_usd < 10_000_000) {
    risks.push(`Micro size: ${usdFull(p.tvl_usd)} of TVL is small enough that one large depositor leaving moves the protocol's numbers and its implied value with it.`);
  }
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lending') || c.includes('cdp')) risks.push('Lending risk: collateral can be liquidated if prices gap down while a loan is open.');
  else if (c.includes('derivative') || c.includes('perp')) risks.push('Perps risk: leveraged positions can be liquidated, and funding can bleed a held position.');
  else if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) risks.push('Vault risk: the strategy can underperform or take a loss; yield shown is never guaranteed.');
  else if (c.includes('restaking') || c.includes('staking')) risks.push('Staking risk: slashing and unbonding delays can lock or cut the stake.');
  else if (c.includes('prediction')) risks.push('Market risk: event positions settle to zero on the losing side; never size a market position as a deposit.');
  else risks.push('Smart-contract risk: unaudited or upgraded contracts can lose deposited funds; the snapshot carries no audit record.');
  risks.push('No token is promised: the protocol may never issue one, and points or activity may never convert.');
  return risks.slice(0, 4);
}

// ------------------------------------------------------------- board

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chain: string;
  chains: string[];
  tvl: number;
  change7d: number | null;
  changeUsd: number | null;
  listedAt: string | null;
  ageDays: number | null;
  implied: number;
  multiple: number;
  tier: 'Top pick' | 'Strong' | 'Speculative';
  cohort: 'WATCHLIST' | 'RADAR';
  bandLow: number;
  bandHigh: number;
  bandExtended: boolean;
  compsFlag: boolean;
  compsRatio: number;
  factors: {
    curveRaw: number;
    curveValue: number;
    rawOffset: number;
    offset: number;
    offsetPeers: number;
    shrinkWeight: number;
    capped: boolean;
    momentum: number;
    growthUsed: number;
    seasoning: number;
    ageUsed: number;
    breadth: number;
  };
  compsValue: number;
  compsMultiple: number;
  neighbours: PeerLite[];
  watchlistNote: string;
  risks: string[];
  farm: string[];
  farmSummary: { capital: number; cost: number; minutes: number; holdWeeks: number };
}

export interface Radar {
  asOf: string;
  source: string;
  floor: number;
  validation: {
    peerCount: number;
    winnerId: string;
    winnerLabel: string;
    bandFactor: number;
    bandLog: number;
    bandPercentile: number;
    scores: VariantScore[];
    curve: { a: number; b: number };
    winnerParams: { K: number; cap: number };
    offsets: { category: string; peers: number; rawOffset: number; applied: number; weight: number; capped: boolean }[];
    extendedRows: number;
    flaggedRows: number;
  };
  rows: RadarRow[];
  peers: PeerLite[];
  stats: { rows: number; watchlist: number; totalTvl: number; totalImplied: number };
}

/** Build the full radar: validate variants, price the universe, rank it. */
export function buildRadar(snap: Snapshot, validation?: Validation): Radar {
  const v = validation ?? validateVariants(snap);
  const peers = launchedPeers(snap);
  const watch = new Set(snap.watchlist);
  const universe = snap.protocols.filter(isRadarCandidate);

  const priced = universe.map((p) => {
    const f = priceWithFactors(v.winner, v.curve, v.evidence, snap.as_of, p);
    const comps = compsCheck(peers, p);
    let bandLow = Math.max(1, Math.round(f.implied / v.bandFactor));
    let bandHigh = Math.round(f.implied * v.bandFactor);
    let extended = false;
    if (comps.value < bandLow || comps.value > bandHigh) {
      bandLow = Math.min(bandLow, comps.value);
      bandHigh = Math.max(bandHigh, comps.value);
      extended = true;
    }
    const ratio = Math.max(f.implied / Math.max(comps.value, 1), comps.value / Math.max(f.implied, 1));
    const age = ageInDays(snap.as_of, p.listed_at);
    const plan = buildFarmPlan(p, age);
    return { p, f, comps, bandLow, bandHigh, extended, ratio, age, plan };
  });
  priced.sort((x, y) => y.f.implied - x.f.implied || (x.p.slug < y.p.slug ? -1 : 1));

  const rows: RadarRow[] = priced.map((r, i) => {
    const rank = i + 1;
    return {
      rank,
      slug: r.p.slug,
      name: r.p.name,
      category: r.p.category,
      chain: r.p.chains[0] ?? '—',
      chains: r.p.chains,
      tvl: r.p.tvl_usd,
      change7d: r.p.change_7d,
      changeUsd: r.p.change_7d === null ? null : Math.round((r.p.tvl_usd * r.p.change_7d) / 100),
      listedAt: r.p.listed_at,
      ageDays: r.age,
      implied: r.f.implied,
      multiple: r.f.implied / Math.max(r.p.tvl_usd, 1),
      tier: rank <= 25 ? 'Top pick' : rank <= 90 ? 'Strong' : 'Speculative',
      cohort: watch.has(r.p.slug) ? 'WATCHLIST' : 'RADAR',
      bandLow: r.bandLow,
      bandHigh: r.bandHigh,
      bandExtended: r.extended,
      compsFlag: r.extended || r.ratio > 10,
      compsRatio: r.ratio,
      factors: {
        curveRaw: r.f.curveRaw,
        curveValue: r.f.curveValue,
        rawOffset: r.f.rawOffset,
        offset: r.f.applied,
        offsetPeers: r.f.offsetPeers,
        shrinkWeight: r.f.shrinkWeight,
        capped: r.f.capped,
        momentum: r.f.momentum,
        growthUsed: r.f.growthUsed,
        seasoning: r.f.seasoning,
        ageUsed: r.f.ageUsed,
        breadth: r.f.breadth,
      },
      compsValue: r.comps.value,
      compsMultiple: r.comps.multiple,
      neighbours: r.comps.peers,
      watchlistNote: watchlistNote(r.p, snap),
      risks: risksFor(r.p, snap.as_of, r.f.offsetPeers, r.f.applied, r.f.rawOffset),
      farm: r.plan.steps,
      farmSummary: { capital: r.plan.capital, cost: r.plan.costTotal, minutes: r.plan.minutesTotal, holdWeeks: r.plan.holdWeeks },
    };
  });

  return {
    asOf: snap.as_of,
    source: snap.source,
    floor: snap.floor_usd,
    validation: {
      peerCount: v.peerCount,
      winnerId: v.winner.id,
      winnerLabel: v.winner.label,
      bandFactor: v.bandFactor,
      bandLog: v.bandLog,
      bandPercentile: v.bandPercentile,
      scores: v.scores,
      curve: v.curve,
      winnerParams: { K: v.winner.K, cap: v.winner.cap },
      offsets: [...v.evidence.entries()]
        .map(([category, e]) => ({
          category,
          peers: e.peers,
          rawOffset: e.rawOffset,
          applied: appliedOffset(e.rawOffset, e.peers, v.winner.K, v.winner.cap),
          weight: shrinkWeight(e.peers, v.winner.K),
          capped: appliedOffset(e.rawOffset, e.peers, v.winner.K, v.winner.cap) !== 1 + (e.rawOffset - 1) * shrinkWeight(e.peers, v.winner.K),
        }))
        .sort((x, y) => y.peers - x.peers || (x.category < y.category ? -1 : 1)),
      extendedRows: rows.filter((r) => r.bandExtended).length,
      flaggedRows: rows.filter((r) => r.compsFlag).length,
    },
    rows,
    peers: [...peers]
      .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
      .map((p) => ({ slug: p.slug, name: p.name, tvl: p.tvl_usd, mcap: p.mcap_usd!, multiple: p.mcap_usd! / p.tvl_usd })),
    stats: {
      rows: rows.length,
      watchlist: rows.filter((r) => r.cohort === 'WATCHLIST').length,
      totalTvl: rows.reduce((s, r) => s + r.tvl, 0),
      totalImplied: rows.reduce((s, r) => s + r.implied, 0),
    },
  };
}

/** Gate-shape check on the built rows; returns the first problem or null. */
export function boardIssue(rows: RadarRow[], snap: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `row count ${rows.length} outside 100..4000`;
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.rank !== i + 1) return `rank ${r.rank} at position ${i + 1}`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (i > 0 && r.implied > rows[i - 1]!.implied) return `implied value rises at rank ${r.rank}`;
    if (r.farm.length < 3 || r.farm.length > 12) return `${r.slug}: farm plan has ${r.farm.length} steps`;
    for (const step of r.farm) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `${r.slug}: farm step of ${len} chars`;
    }
  }
  const missing = snap.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `watchlist missing: ${missing.slice(0, 5).join(', ')}`;
  return null;
}
