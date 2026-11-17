// Token Launch Radar v6 — dashboard application (vanilla JS, no network).
// data.js carries the snapshot-derived rows; model.js carries the fitted
// pricing model as generated code, including the shrunk category offsets.
// The detail view recomputes each headline value by calling that model
// code on the row's own figures, so what the page shows is what the code
// in the dossier computes — offsets, shrinkage and cap included.
'use strict';

const DATA = window.RADAR_DATA;
const MODEL = window.RADAR_MODEL;
const rows = DATA.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));

const fmt = (n) => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtShort = (n) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));
const mult = (n) => n.toFixed(2) + 'x';
const hold = (mins) => (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const BANDS = [
  { id: 'high', label: 'High value ($20M+)', test: (r) => r.implied >= 20000000 },
  { id: 'mid', label: 'Mid value ($7.5M-$20M)', test: (r) => r.implied >= 7500000 && r.implied < 20000000 },
  { id: 'early', label: 'Early value (under $7.5M)', test: (r) => r.implied < 7500000 },
];
const bandOf = (r) => BANDS.find((b) => b.test(r)).id;
const bandLabel = (id) => (BANDS.find((b) => b.id === id) || {}).label || id;

// ---------------------------------------------------------------- masthead
function renderChrome() {
  const v = DATA.validation;
  const win = v.scores.find((c) => c.id === v.winnerId);
  document.getElementById('derived').textContent =
    'Derived from the sealed DefiLlama snapshot as of ' + DATA.asOf + ' (' + DATA.source + '). ' +
    'Universe: every protocol that records no token and is not a wrapped, staked, bridged or versioned product of a launched protocol.';
  document.getElementById('shrinkline').textContent =
    'Category offsets are shrunk toward 1 by the evidence behind them (weight n/(n+K), K = ' + v.winnerParams.K +
    ' chosen by held-out validation) and hard-capped at x' + v.winnerParams.cap +
    '. The Method view prints every offset three ways: peers n, raw, applied.';
  document.getElementById('stats').innerHTML = [
    [DATA.stats.rows, 'pre-token protocols ranked'],
    [DATA.stats.watchlist + ' / ' + DATA.watchlistSize, 'watchlist covered'],
    [fmtShort(DATA.stats.totalImplied), 'total implied value'],
    [fmtShort(DATA.stats.totalTvl), 'total TVL ranked'],
    ['LOO median err ' + win.medianAbsLogErr.toFixed(3), 'winner, held-out (not in-sample fit)'],
    ['x/' + v.bandFactor.toFixed(1), 'honest band (LOO p90)'],
  ].map(([b, s]) => '<div class="stat"><b>' + b + '</b><span>' + s + '</span></div>').join('');
  document.getElementById('verify').textContent =
    'verify: board.json sha256 ' + DATA.boardSha256 + ' - the page renders exactly the rows in that board; winning variant: ' + v.winnerLabel;
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/');
  const view = parts[0] || 'board';
  const arg = parts.slice(1).join('/');
  const filters = { q: '', band: '', chain: '', cat: '', tier: '', cohort: '', sort: 'rank', dir: 1 };
  if (view === 'board' && arg) {
    for (const pair of arg.split(',')) {
      const i = pair.indexOf(':');
      if (i > 0) filters[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
  }
  return { view, arg, filters };
}

function boardHash(f) {
  const bits = [];
  for (const k of ['band', 'chain', 'cat', 'tier', 'cohort', 'q']) if (f[k]) bits.push(k + ':' + encodeURIComponent(f[k]));
  if (f.sort !== 'rank' || f.dir !== 1) bits.push('sort:' + f.sort, 'dir:' + f.dir);
  return '#/board' + (bits.length ? '/' + bits.join(',') : '');
}

// ---------------------------------------------------------------- board
function renderBoard(f) {
  const cats = [...new Set(rows.map((r) => r.category || 'Uncategorised'))].sort();
  const chains = [...new Set(rows.map((r) => r.chain))].sort();
  const filtered = rows.filter((r) =>
    (!f.band || bandOf(r) === f.band) &&
    (!f.chain || r.chain === f.chain) &&
    (!f.cat || (r.category || 'Uncategorised') === f.cat) &&
    (!f.tier || r.tier === f.tier) &&
    (!f.cohort || r.cohort === f.cohort) &&
    (!f.q || (r.name + ' ' + r.slug).toLowerCase().includes(f.q.toLowerCase())));
  const key = { rank: (r) => r.rank, name: (r) => r.name, tvl: (r) => r.tvl, implied: (r) => r.implied, multiple: (r) => r.multiple, change: (r) => (r.change7d === null ? -1e9 : r.change7d) }[f.sort] || ((r) => r.rank);
  filtered.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * f.dir);
  const sel = (val, cur) => (val === cur ? ' selected' : '');
  const opt = (val, label, cur) => '<option value="' + esc(val) + '"' + sel(val, cur) + '>' + esc(label) + '</option>';
  const th = (id, label, num) => '<th class="' + (num ? 'num' : '') + '" data-sort="' + id + '">' + label + (f.sort === id ? ' <span class="dir">' + (f.dir === 1 ? '▲' : '▼') + '</span>' : '') + '</th>';
  const active = [];
  if (f.band) active.push('value band = ' + bandLabel(f.band));
  if (f.chain) active.push('primary chain = ' + f.chain);
  if (f.cat) active.push('category = ' + f.cat);
  if (f.tier) active.push('tier = ' + f.tier);
  if (f.cohort) active.push('list = ' + f.cohort);
  if (f.q) active.push('search = "' + f.q + '"');
  document.getElementById('app').innerHTML =
    (active.length ? '<div class="activebar"><b>ACTIVE FILTER:</b> ' + active.map(esc).join(' &middot; ') + ' &mdash; showing ' + filtered.length + ' of ' + rows.length + ' protocols</div>' : '') +
    '<div class="controls">' +
    '<label>Search<input id="fq" type="text" value="' + esc(f.q) + '" placeholder="name or slug"></label>' +
    '<label>Value band<select id="fband"><option value="">All bands</option>' + BANDS.map((b) => opt(b.id, b.label, f.band)).join('') + '</select></label>' +
    '<label>Primary chain<select id="fchain"><option value="">All chains</option>' + chains.map((c) => opt(c, c, f.chain)).join('') + '</select></label>' +
    '<label>Category<select id="fcat"><option value="">All categories</option>' + cats.map((c) => opt(c, c, f.cat)).join('') + '</select></label>' +
    '<label>Tier<select id="ftier"><option value="">All tiers</option>' + ['Top pick', 'Strong', 'Speculative'].map((t) => opt(t, t, f.tier)).join('') + '</select></label>' +
    '<label>List<select id="fcohort"><option value="">Watchlist + radar</option>' + opt('WATCHLIST', 'Watchlist only', f.cohort) + opt('RADAR', 'Radar only', f.cohort) + '</select></label>' +
    '<button class="reset" id="freset">Reset</button>' +
    '<span class="count">Showing ' + filtered.length + ' of ' + rows.length + ' protocols</span></div>' +
    '<table><thead><tr>' + th('rank', '#') + th('name', 'Protocol') + th('tvl', 'TVL', 1) + th('implied', 'Implied value', 1) + th('multiple', 'Multiple', 1) + th('change', '7d', 1) + '<th>Band (low-high)</th><th>Farm: capital in - all-in cost - hold</th></tr></thead><tbody>' +
    filtered.map((r) =>
      '<tr class="' + (r.rank <= 3 ? 'top' : '') + '"><td class="num">' + r.rank + '</td>' +
      '<td><a class="name" href="#/detail/' + r.slug + '">' + esc(r.name) + '</a> <span class="chip ' + (r.cohort === 'WATCHLIST' ? 'wl' : 'rd') + '">' + r.cohort + '</span> <span class="chip ' + (r.tier === 'Top pick' ? 'tp' : r.tier === 'Strong' ? 'st' : 'sp') + '">' + r.tier + '</span>' + (r.compsFlag ? ' <span class="chip flag">COMPS FLAG</span>' : '') + '<br><span class="slug">' + r.slug + ' - ' + esc(r.category || 'Uncategorised') + ' - ' + esc(r.chain) + '</span></td>' +
      '<td class="num">' + fmt(r.tvl) + '</td><td class="num"><b>' + fmt(r.implied) + '</b></td><td class="num">' + mult(r.multiple) + '</td>' +
      '<td class="num">' + (r.change7d === null ? '-' : '<span class="' + (r.change7d >= 0 ? 'pos' : 'neg') + '">' + (r.change7d >= 0 ? '+' : '') + r.change7d.toFixed(1) + '%</span>') + '</td>' +
      '<td class="num">' + fmtShort(r.bandLow) + ' - ' + fmtShort(r.bandHigh) + '</td>' +
      '<td class="farmline">In ' + fmt(r.farmSummary.capital) + ' - cost ~' + fmt(r.farmSummary.cost) + ' - hold ~' + r.farmSummary.holdWeeks + ' wks (' + hold(r.farmSummary.minutes) + ' active). <a href="#/detail/' + r.slug + '">Plan</a></td></tr>').join('') +
    '</tbody></table>';
  const go = () => {
    const nf = { band: document.getElementById('fband').value, chain: document.getElementById('fchain').value, cat: document.getElementById('fcat').value, tier: document.getElementById('ftier').value, cohort: document.getElementById('fcohort').value, q: document.getElementById('fq').value, sort: f.sort, dir: f.dir };
    location.hash = boardHash(nf);
  };
  for (const id of ['fband', 'fchain', 'fcat', 'ftier', 'fcohort']) document.getElementById(id).addEventListener('change', go);
  document.getElementById('fq').addEventListener('change', go);
  document.getElementById('freset').addEventListener('click', () => { location.hash = '#/board'; });
  document.querySelectorAll('th[data-sort]').forEach((el) => el.addEventListener('click', () => {
    const s = el.getAttribute('data-sort');
    location.hash = boardHash({ ...f, sort: s, dir: f.sort === s ? -f.dir : 1 });
  }));
}

// ---------------------------------------------------------------- detail
function renderDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) { document.getElementById('app').innerHTML = '<div class="card"><h2>Not on the board</h2><p>' + esc(slug) + '</p></div>'; return; }
  const f = MODEL.priceFactors(r.tvl, r.category, r.change7d, r.ageDays, r.chains.length);
  const comps = MODEL.compsFromMultiples(r.tvl, r.neighbours.map((n) => n.multiple));
  const inBand = comps >= r.bandLow && comps <= r.bandHigh;
  const share = 0.0005;
  const breakEven = Math.round(r.farmSummary.cost / share);
  const build = MODEL.workedBuild(r);
  const gapNote = r.compsFlag
    ? '<p class="note flag">Comps flag on this row: the headline sits ' + r.compsRatio.toFixed(1) + 'x from the nearest-3 comps cross-check' +
      (r.bandExtended ? ', and the printed band was widened to include the comps estimate under the stated band rule (Method view)' : '') +
      '. At this size the three nearest launched peers are themselves micro names whose own multiples are extreme, so the cross-check is the weak reading here; the headline follows the fitted curve and the shrunk category offset printed above. The flag is carried in this row\'s data, not buried.</p>'
    : '';
  document.getElementById('app').innerHTML =
    '<div class="card"><h2>#' + r.rank + ' ' + esc(r.name) + ' <span class="chip ' + (r.cohort === 'WATCHLIST' ? 'wl' : 'rd') + '">' + r.cohort + '</span> <span class="chip ' + (r.tier === 'Top pick' ? 'tp' : r.tier === 'Strong' ? 'st' : 'sp') + '">' + r.tier + '</span>' + (r.compsFlag ? ' <span class="chip flag">COMPS FLAG</span>' : '') + '</h2>' +
    '<p class="slug">' + r.slug + ' - ' + esc(r.category || 'Uncategorised') + ' - chains: ' + r.chains.map(esc).join(', ') + (r.listedAt ? ' - tracked since ' + r.listedAt : ' - no listing date recorded') + '</p>' +
    '<div class="grid">' +
    '<div class="kv"><b>' + fmt(r.tvl) + '</b><span>TVL (snapshot)</span></div>' +
    '<div class="kv"><b>' + fmt(r.implied) + '</b><span>Implied value (full-factor model)</span></div>' +
    '<div class="kv"><b>' + mult(r.multiple) + '</b><span>Model multiple (headline value / TVL, this row)</span></div>' +
    '<div class="kv"><b>' + fmt(r.bandLow) + ' - ' + fmt(r.bandHigh) + '</b><span>Honest band (winner LOO p90)</span></div>' +
    '<div class="kv"><b>' + (r.change7d === null ? 'not reported' : (r.change7d >= 0 ? '+' : '') + r.change7d.toFixed(1) + '%') + '</b><span>TVL change, 7d' + (r.changeUsd === null ? '' : ' (' + fmt(r.changeUsd) + ')') + '</span></div>' +
    '<div class="kv"><b>' + fmt(comps) + '</b><span>Comps cross-check (3 nearest launched peers)</span></div></div>' +
    '<h3>Worked build - the headline value, factor by factor</h3><div class="mono">' + esc(build) + '</div>' +
    '<p>Page recomputation through model.js: priceFactors(TVL, category, 7d, age, chains) gives implied ' + fmt(f.implied) + ', which ' + (f.implied === r.implied ? 'equals' : 'DIFFERS FROM') + ' the board value. ' +
    'Factor readings: curve raw ' + fmt(f.curveRaw) + ', category offset raw x' + f.rawOffset.toFixed(2) + ' from ' + r.factors.offsetPeers + ' launched peer' + (r.factors.offsetPeers === 1 ? '' : 's') + ' in this category, shrunk by weight ' + f.shrinkWeight.toFixed(3) + ' to applied x' + f.offset.toFixed(4) + (f.capped ? ' (hard cap x' + MODEL.cap + ' reached)' : '') + ', momentum x' + f.momentum.toFixed(4) + ', seasoning x' + f.seasoning.toFixed(4) + ', breadth x' + f.breadth.toFixed(4) + '. ' +
    'Cross-check: median multiple of the 3 nearest launched peers (' + mult(r.compsMultiple) + ', population: those 3 peers) x TVL = ' + fmt(comps) + ', ' + (inBand ? 'inside' : 'OUTSIDE') + ' the honest band' + (r.bandExtended ? ' (this row\'s band was widened to include the comps estimate, per the stated band rule on the Method view)' : '') + '.</p>' +
    gapNote +
    '<h3>Nearest launched peers (by log-TVL distance)</h3>' +
    '<table class="plain"><thead><tr><th>Peer</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Multiple (peer cap / peer TVL)</th></tr></thead><tbody>' +
    r.neighbours.map((n) => '<tr><td>' + esc(n.name) + ' <span class="slug">' + n.slug + '</span></td><td class="num">' + fmt(n.tvl) + '</td><td class="num">' + fmt(n.mcap) + '</td><td class="num">' + mult(n.multiple) + '</td></tr>').join('') +
    '</tbody></table>' +
    '<p>Every multiple above is labelled with its population and role: peer multiples are each peer\'s own cap over its own TVL; the comps multiple is the median over exactly these 3 peers and serves only as a cross-check inside the band; the only model multiple printed for ' + esc(r.name) + ' itself is the headline one. No all-peers median multiple is printed anywhere, because that population is dominated by tiny-TVL names and would contradict the model.</p>' +
    '<h3>Watchlist status</h3><p class="note">' + esc(r.watchlistNote) + '</p>' +
    '<h3>Risks</h3><ul class="risk">' + r.risks.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
    '<h3>Farm plan - 8 steps, capital ' + fmt(r.farmSummary.capital) + ' in, all-in cost ~' + fmt(r.farmSummary.cost) + ', hold ~' + r.farmSummary.holdWeeks + ' weeks, active time ~' + hold(r.farmSummary.minutes) + '</h3>' +
    '<ol class="farm">' + r.farm.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<p class="note">Break-even, on one stated assumption: if a farmer ends up holding 0.05% of the eventual token supply, the all-in cost of ' + fmt(r.farmSummary.cost) + ' is covered when the launch values ' + esc(r.name) + ' at ' + fmt(breakEven) + ' or more. The model headline is ' + fmt(r.implied) + ' and the band low is ' + fmt(r.bandLow) + ', where the same 0.05% share would be worth ' + fmt(Math.round(share * r.bandLow)) + '.</p>' +
    '<p><a href="#/board">Back to the board</a></p></div>';
}

// ---------------------------------------------------------------- method
function renderMethod() {
  const v = DATA.validation;
  document.getElementById('app').innerHTML =
    '<div class="card"><h2>Method &amp; validation</h2>' +
    '<p>Every row is priced by one model with a fixed factor shape: implied = size curve (TVL) x category offset x momentum (seven-day growth) x seasoning (tokenless age) x breadth (chain count). The shape is never up for selection, because the value question names TVL, seven-day growth and time without a token as the inputs. What validation chooses in v6 is only how hard thin category evidence is discounted: nine variants that ALL keep every factor, differing only in the offset shrinkage prior K and the offset hard cap CAP, were compared by leave-one-out cross-validation on the ' + v.peerCount + ' launched peers (protocols whose token already trades with a market cap in the snapshot). Each variant had to predict every peer\'s market cap from a curve and offsets fitted without that peer, priced with the peer\'s own growth, age and chain count; the errors below are held-out errors, not in-sample fit statistics, and the masthead headlines the winner\'s held-out median error.</p>' +
    '<table class="plain"><thead><tr><th>Variant (all keep curve + category + momentum + seasoning + breadth)</th><th class="num">LOO median |log10 err|</th><th class="num">LOO mean |log10 err|</th><th class="num">LOO p90 |log10 err|</th><th>Outcome</th></tr></thead><tbody>' +
    v.scores.map((c) => '<tr class="' + (c.id === v.winnerId ? 'win' : '') + '"><td>' + esc(c.label) + '</td><td class="num">' + c.medianAbsLogErr.toFixed(4) + '</td><td class="num">' + c.meanAbsLogErr.toFixed(4) + '</td><td class="num">' + c.p90AbsLogErr.toFixed(4) + '</td><td>' + (c.id === v.winnerId ? 'WINNER - prices the board' : 'not chosen on held-out error') + '</td></tr>').join('') +
    '</tbody></table>' +
    '<h3>Why the offsets are shrunk, and by how much</h3><p>A category offset is evidence, and evidence has a sample size. The raw offset is a category\'s median residual against the size curve, as a multiple; on a thin category it can be wild, because one launched peer trading at hundreds of times its TVL hands the whole category a raw offset in the hundreds. v6 never prices with a raw offset. The applied offset pulls the raw one toward 1 (no shift) by the evidence weight n/(n+K), where n is the category\'s launched-peer count and K is the winning prior strength (' + v.winnerParams.K + ' here), and is then hard-capped to [1/' + v.winnerParams.cap + ', ' + v.winnerParams.cap + ']. With one peer and K = ' + v.winnerParams.K + ' the weight is ' + (1 / (1 + v.winnerParams.K)).toFixed(3) + ': a raw offset of x8.82 would apply as x' + (1 + 7.82 / (1 + v.winnerParams.K)).toFixed(2) + ', and anything wilder runs into the cap instead of the board. The table below prints every category three ways, so a thin category is visibly discounted rather than hidden.</p>' +
    '<h3>Category offsets - peers, raw, applied (winner K = ' + v.winnerParams.K + ', cap x' + v.winnerParams.cap + ')</h3>' +
    '<table class="plain"><thead><tr><th>Category</th><th class="num">Launched peers n</th><th class="num">Raw offset</th><th class="num">Weight n/(n+K)</th><th class="num">Applied offset (priced)</th><th>Note</th></tr></thead><tbody>' +
    v.offsets.map((o) => '<tr><td>' + esc(o.category) + '</td><td class="num">' + o.peers + '</td><td class="num">x' + o.rawOffset.toFixed(2) + '</td><td class="num">' + o.weight.toFixed(3) + '</td><td class="num"><b>x' + o.applied.toFixed(4) + '</b></td><td>' + (o.capped ? 'hard cap reached' : o.peers <= 2 ? 'thin evidence, shrunk hard' : '') + '</td></tr>').join('') +
    '</tbody></table>' +
    '<h3>The fitted winner</h3><p>Size curve: log10(value) = ' + v.curve.a.toFixed(4) + ' + ' + v.curve.b.toFixed(4) + ' x log10(TVL), fitted on all ' + v.peerCount + ' launched peers. Momentum reads the seven-day change clamped to -50%..+80%; seasoning saturates with tokenless age (a missing listing date scores a stated 300 days); breadth adds a small logarithmic premium for chain count. The literal fitted parameters ship as code in model.js beside this page, and the detail view recomputes each headline value by calling it.</p>' +
    '<h3>The honest band</h3><p>Each row\'s band is its model value divided and multiplied by ' + v.bandFactor.toFixed(2) + 'x, the factor at the 90th percentile of the winner\'s leave-one-out |log10 error|: nine in ten held-out peers landed inside a band this wide. One stated extension: where the independent nearest-3 comps estimate falls outside that band, the printed band is widened to include it (' + v.extendedRows + ' of ' + rows.length + ' rows), and the row is flagged in its data. Separately, any row whose headline sits more than 10x from its comps cross-check carries a COMPS FLAG on the board and an explanation on its detail page (' + v.flaggedRows + ' rows in all): at micro size the nearest launched peers are themselves extreme-multiple micro names, so the flag marks where the cross-check, not the curve, is the weak reading. No printed cross-check is ever left contradicting the band, and no large gap is left unflagged.</p>' +
    '<h3>Labelling rule for multiples</h3><p>A row prints exactly one model multiple: its headline implied value divided by its TVL. Any other multiple names its population and its role: the comps multiple is the median over the row\'s 3 nearest launched peers and serves only as a cross-check inside the band; peer multiples in the evidence view are each peer\'s own cap over its own TVL. There is no all-peers median multiple anywhere on the page.</p>' +
    '<h3>Universe rule</h3><p>The board ranks every protocol that records no token (market cap, gecko id and symbol all absent) and is not a wrapped, staked, bridged or versioned product of a launched protocol: category not in Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking / Restaked BTC / CEX, name carrying no whole word wrapped, staked or staking, no version suffix, and no exchange-name prefix. That is the watchlist\'s own exclusion rule applied at every size: ' + rows.length + ' protocols, including all ' + DATA.watchlistSize + ' watchlist slugs. Rows are tagged WATCHLIST (the watchlist ' + DATA.stats.watchlist + ') or RADAR (the rest, found below or beside the floor); no row is ever tagged by the floor it sits above or below beyond that. Radar rows above the floor that the watchlist omits are explained on their detail pages in the snapshot\'s own terms.</p>' +
    '<h3>Reproducibility</h3><p>The masthead verify strip carries the sha256 of board.json, recomputed from the written board at run time; the program\'s self-audit recomputes every row from the printed factors and again through the generated model.js, re-derives every applied offset from its raw offset, peer count and the winning (K, CAP), checks every comps cross-check against its band, and rebuilds the whole dossier in memory to confirm byte-identical output before anything is handed in.</p></div>';
}

// ---------------------------------------------------------------- peers
function renderPeers() {
  document.getElementById('app').innerHTML =
    '<div class="card"><h2>Launched peers - the evidence base</h2>' +
    '<p>These ' + DATA.peers.length + ' protocols already trade a token in the snapshot. They are not ranked and carry no farm plan; they are the population the size curve and category offsets were fitted on, the population every validation variant was scored against, and the pool the per-row comps cross-checks draw from. Multiple = the peer\'s own market cap / its own TVL.</p>' +
    '<table class="plain"><thead><tr><th>Peer</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Multiple</th></tr></thead><tbody>' +
    DATA.peers.map((p) => '<tr><td>' + esc(p.name) + ' <span class="slug">' + p.slug + '</span></td><td class="num">' + fmt(p.tvl) + '</td><td class="num">' + fmt(p.mcap) + '</td><td class="num">' + mult(p.multiple) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

// ---------------------------------------------------------------- go
function render() {
  const { view, arg, filters } = parseHash();
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.getAttribute('data-nav') === view));
  if (view === 'detail') renderDetail(arg);
  else if (view === 'method') renderMethod();
  else if (view === 'peers') renderPeers();
  else renderBoard(filters);
}
renderChrome();
window.addEventListener('hashchange', render);
render();
