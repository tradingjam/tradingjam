// Backtest „TOP 10”: jak skuteczne byłyby scenariusze wybierane do TOP 10 w przeszłości,
// przy różnych modelach i zasadach wyboru. Wszystko liczone walk-forward (model zna tylko przeszłość).
// Tryb 2:1 (cel 2×ATR, stop 1×ATR). Wynik: trafione cele, średni wynik w R na scenariusz.
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');
const I = E._internal;

const IV = process.env.IV || '1h';
const STEP = { '1h': 36e5, '4h': 4 * 36e5, '1d': 864e5, '30d': 864e5 }[IV];
const BARS = IV === '30d' ? '1d' : IV;           // 30 dni liczone ze świec dziennych
const SCALE = E.CFG[IV].scale || 1;
const MIN_BARS = BARS === '1d' ? 500 : 900;
const N_BINANCE = +(process.env.N_BINANCE || 70), N_BINGX = +(process.env.N_BINGX || 50);
const MODE = process.env.MODE || 'big';
const LEVS = { big: [2, 1], equal: [2, 2], equal15: [1.5, 1.5], safe: [1, 2] };
const AUTO = MODE === 'auto';            // auto: model sam wybiera układ (2:1, 1:1, 1:2) dla każdego scenariusza
const LEV = LEVS[AUTO ? 'big' : MODE]; // [cel, stop] w ATR
// model jak w aplikacji dla danego horyzontu
const PROD = { '1h': 'mtfbtc', '4h': 'btc', '1d': 'btc', '30d': 'base' }[IV];
const RW = LEV[0] / LEV[1];                 // ile R daje trafiony cel
const VALID_N = 1000, REFIT = 200, BE = LEV[1] / (LEV[0] + LEV[1]);

// ---------- Wątek: dane i predykcje per coin ----------
function features(k, ctx, k4) {
  const { F, raw } = I.buildFeatures(k, ctx, k4);
  return { Z: I.zscore(F), raw };
}
function labels(k, raw, H, lev = LEV) {
  const tg = lev[0] * SCALE, st = lev[1] * SCALE;
  return { L: I.outcomes(k, raw, H, tg, st), S: I.outcomes(k, raw, H, st, tg).map(y => (y === null ? null : -y)) };
}
// walk-forward per coin: zwraca dla punktów testu p, prior (z przeszłości) i wynik
function walk(Z, Y, lab, H, l2, btcAt) {
  const out = []; if (lab.length < 500) return out;
  const vs = lab.slice(Math.max(300 + H, lab.length - VALID_N));
  let model = null, fittedAt = -Infinity, bm = 0, bb = 0, n = 0;
  for (const t of vs) {
    if (t - fittedAt >= REFIT) { model = I.fitModel(Z, Y, lab.filter(i => i <= t - H), model && model.W, l2); fittedAt = t; }
    const p = I.predictP(model, Z[t]);
    const rskill = n >= 100 && bb > 0 ? 1 - bm / bb : null;
    out.push({ i: t, p: p[0], prior: model.prior[0], y: Y[t], rskill, bt: btcAt ? btcAt(t) : null, ct: walk.raw && walk.raw[t] ? walk.raw[t].trend : null, br: walk.br ? walk.br(t) : null });
    // skill liczony tylko z wcześniejszych punktów testu (bez zaglądania w przyszłość)
    if (t + H <= vs[vs.length - 1]) { bm += I.brier(p, Y[t]); bb += I.brier(model.prior, Y[t]); n++; }
  }
  return out;
}
// Dodatkowe wskaźniki dla świec dziennych: kontekst BTC + odległość od EMA200, położenie w zakresie 90 dni,
// siła względem BTC z 30 dni, zmienność teraz vs zwykle (ATR14 / ATR100)
function extCtx(k, btcK, btcCtx) {
  const bc = new Map(); btcK.t.forEach((t, i) => bc.set(t, btcK.c[i]));
  const n = k.c.length, tr = new Array(n).fill(0); let e = k.c[0]; const a = 2 / 201;
  const out = { t: [], v: [] }; let jb = 0, s14 = 0, s100 = 0;
  for (let i = 0; i < n; i++) {
    tr[i] = i ? Math.max(k.h[i] - k.l[i], Math.abs(k.h[i] - k.c[i - 1]), Math.abs(k.l[i] - k.c[i - 1])) : k.h[i] - k.l[i];
    s14 += tr[i] - (i >= 14 ? tr[i - 14] : 0); s100 += tr[i] - (i >= 100 ? tr[i - 100] : 0);
    e = i ? a * k.c[i] + (1 - a) * e : e;
    if (i < 200) continue;
    while (jb + 1 < btcCtx.t.length && btcCtx.t[jb + 1] <= k.t[i]) jb++;
    if (btcCtx.t[jb] > k.t[i]) continue;
    const b0 = bc.get(k.t[i]), b30 = bc.get(k.t[i - 30]); if (!b0 || !b30) continue;
    let hi = -Infinity, lo = Infinity; for (let j = i - 89; j <= i; j++) { if (k.h[j] > hi) hi = k.h[j]; if (k.l[j] < lo) lo = k.l[j]; }
    const pos = hi > lo ? (k.c[i] - lo) / (hi - lo) - 0.5 : 0;
    const rs = Math.log(k.c[i] / k.c[i - 30]) - Math.log(b0 / b30);
    const vr = s100 > 0 ? (s14 / 14) / (s100 / 100) - 1 : 0;
    out.t.push(k.t[i]); out.v.push([...btcCtx.v[jb], Math.max(-1, Math.min(3, k.c[i] / e - 1)), pos, Math.max(-2, Math.min(2, rs)), Math.max(-1, Math.min(3, vr))]);
  }
  return out;
}
async function worker() {
  const H = E.CFG[IV].H; const btcCtx = E.btcContext(workerData.btc);
  // trend BTC (odległość od EMA50 w ATR) w chwili danej świecy coina
  const btcAtFor = k => { let j = 0; return i => { while (j + 1 < btcCtx.t.length && btcCtx.t[j + 1] <= k.t[i]) j++; if (btcCtx.t[j] > k.t[i]) j = 0; return btcCtx.t[j] <= k.t[i] ? btcCtx.v[j][0] : null; }; };
  for (const t of workerData.list) {
    try {
      const k = workerData.kl ? workerData.kl[t.ex + t.sym] : await X.getKlines(t.ex, t.sym, BARS, E.HISTORY);
      if (!k) continue;
      if (k.c.length < MIN_BARS) continue;
      const k4 = IV === '1h' ? await X.getKlines(t.ex, t.sym, '4h', 1200) : null;
      const recs = {};
      const fAt = btcAtFor(k); const btArr = k.t.map((_, i) => fAt(i)); const bAt = i => btArr[i];
      // nastrój rynku (dla świec dziennych): odsetek coinów nad EMA50 i jego zmiana z 5 dni
      const brCtx = workerData.breadth || null; let brArr = null;
      if (brCtx) { let j = 0; brArr = k.t.map(tt => { while (j + 1 < brCtx.t.length && brCtx.t[j + 1] <= tt) j++; return brCtx.t[j] <= tt ? brCtx.v[j][0] : null; }); }
      const run = (name, Z, raw, l2, lev) => { walk.raw = raw; walk.br = brArr ? (i => brArr[i]) : null;
        const Y = labels(k, raw, H, lev); const lab = Y => { const a = []; for (let i = 0; i < k.c.length - 1 - H; i++) if (Z[i] && Y[i] !== null) a.push(i); return a; };
        const lL = lab(Y.L), lS = lab(Y.S);
        recs[name] = { L: walk(Z, Y.L, lL, H, l2, bAt).map(r => ({ ...r, t: k.t[r.i] })), S: walk(Z, Y.S, lS, H, l2, bAt).map(r => ({ ...r, t: k.t[r.i] })) };
        return { Y, lL, lS };
      };
      if (AUTO) {
        const ctxOf = { base: [k], btc: [k, btcCtx], mtfbtc: [k, btcCtx, k4] };
        const names = IV === '30d' ? ['base', 'btc'] : [PROD];
        for (const nm of names) { const f = features(...ctxOf[nm]); for (const ly of ['big', 'equal', 'safe']) run(nm + '|' + ly, f.Z, f.raw, 0.3, LEVS[ly]); }
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs, pool: null }); continue;
      }
      const base = features(k); const b = run('base', base.Z, base.raw, 0.3);
      const fb = features(k, btcCtx); run('btc', fb.Z, fb.raw, 0.3);
      if (brCtx) {
        const fbr = features(k, brCtx); run('breadth', fbr.Z, fbr.raw, 0.3);
        const both = { t: btcCtx.t, v: btcCtx.v.map((v, i) => { const tt = btcCtx.t[i]; let lo = 0, hi = brCtx.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (brCtx.t[m] <= tt) { j = m; lo = m + 1; } else hi = m - 1; } return j >= 0 ? [...v, ...brCtx.v[j]] : null; }) };
        both.t = both.t.filter((_, i) => both.v[i]); both.v = both.v.filter(Boolean);
        const fbb = features(k, both); run('btcbreadth', fbb.Z, fbb.raw, 0.3);
      }
      if (BARS === '1d') { try { const ext = extCtx(k, workerData.btc, btcCtx); if (ext.t.length > 300) { const fe = features(k, ext); run('btcext', fe.Z, fe.raw, 0.3); } } catch (e) { } }
      if (k4) { const fm = features(k, null, k4); run('mtf', fm.Z, fm.raw, 0.3); const fmb = features(k, btcCtx, k4); run('mtfbtc', fmb.Z, fmb.raw, 0.3); }
      // dane do modelu wspólnego (wszystkie coiny razem)
      const pool = { t: [], Z: [], L: [], S: [] };
      for (let i = 0; i < k.c.length - 1 - H; i++) if (base.Z[i] && b.Y.L[i] !== null && b.Y.S[i] !== null) { pool.t.push(k.t[i]); pool.Z.push(base.Z[i]); pool.L.push(b.Y.L[i]); pool.S.push(b.Y.S[i]); }
      parentPort.postMessage({ coin: t.ex + ':' + t.base, recs, pool });
    } catch (e) { }
  }
}

// ---------- Główny wątek ----------
function pooledPreds(coins, H) {
  // model wspólny: co 200 świec douczany na danych WSZYSTKICH coinów sprzed chwili t−H
  const all = []; coins.forEach((c, ci) => c.pool.t.forEach((t, j) => all.push({ ci, t, z: c.pool.Z[j], L: c.pool.L[j], S: c.pool.S[j] })));
  all.sort((a, b) => a.t - b.t);
  const tMax = all[all.length - 1].t; const tStart = tMax - VALID_N * STEP;
  const res = coins.map(() => ({ L: [], S: [] }));
  for (const side of ['L', 'S']) {
    let model = null; const rng = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    for (let T = tStart; T <= tMax; T += REFIT * STEP) {
      let train = all.filter(r => r.t <= T - H * STEP);
      if (train.length > 40000) train = train.filter(() => rng() < 40000 / train.length);
      const Z = train.map(r => r.z), Y = train.map(r => r[side]);
      model = I.fitModel(Z, Y, Z.map((_, i) => i), model && model.W, 0.3);
      for (const r of all) if (r.t >= T && r.t < T + REFIT * STEP) {
        const p = I.predictP(model, r.z);
        res[r.ci][side].push({ t: r.t, p: p[0], y: r[side] });
      }
    }
  }
  // prior coina: częstość z jego przeszłości; skill per coin – narastająco z wcześniejszych predykcji
  coins.forEach((c, ci) => {
    for (const side of ['L', 'S']) {
      const lab = c.pool.t.map((t, j) => ({ t, y: c.pool[side][j] })).sort((x, y) => x.t - y.t);
      let bm = 0, bb = 0, n = 0, ptr = 0, cw = 0, cnt = 0;
      res[ci][side] = res[ci][side].sort((a, b) => a.t - b.t).map(r => {
        while (ptr < lab.length && lab[ptr].t <= r.t - H * STEP) { cnt++; if (lab[ptr].y === 1) cw++; ptr++; }
        const prior = cnt ? cw / cnt : 0.33;
        const rskill = n >= 100 && bb > 0 ? 1 - bm / bb : null;
        bm += (r.p - (r.y === 1 ? 1 : 0)) ** 2; bb += (prior - (r.y === 1 ? 1 : 0)) ** 2; n++;
        return { ...r, prior, rskill };
      });
    }
  });
  return res;
}

function simulate(coinRecs, rule, H) {
  // coinRecs: [{ coin, L:[{t,p,prior,y,rskill}], S:[...] }]
  const byT = new Map();
  for (const c of coinRecs) for (const side of ['L', 'S']) for (const r of c[side]) {
    if (!byT.has(r.t)) byT.set(r.t, new Map());
    const m = byT.get(r.t); const prev = m.get(c.coin);
    const cand = { coin: c.coin, side, ...r, lift: r.p - r.prior };
    const ok = x => x.rskill !== null && x.rskill > 0;
    // jak w aplikacji: mocniejszy scenariusz coina, sprawdzony ma pierwszeństwo
    if (!prev || (ok(cand) && !ok(prev)) || (ok(cand) === ok(prev) && cand.p > prev.p)) m.set(c.coin, cand);
  }
  const times = [...byT.keys()].sort((a, b) => a - b);
  const blocked = new Map(); let win = 0, loss = 0, none = 0;
  for (const t of times) {
    let cands = [...byT.get(t).values()].filter(x => rule.filter(x));
    cands.sort(rule.sort);
    let taken = 0;
    for (const x of cands) {
      if (taken >= rule.top) break;
      const key = x.coin + x.side; if ((blocked.get(key) || 0) > t) continue;
      blocked.set(key, t + H * STEP); taken++;
      if (x.y === 1) win++; else if (x.y === -1) loss++; else none++;
    }
  }
  const n = win + loss + none;
  return { n, hit: win + loss ? win / (win + loss) : 0, avgR: n ? (RW * win - loss) / n : 0 };
}

async function main() {
  const t0 = Date.now(); const H = E.CFG[IV].H;
  const bn = (await X.binanceTickers()).filter(t => t.qv >= 3e6).sort((a, b) => b.qv - a.qv).slice(0, N_BINANCE);
  const onB = new Set(bn.map(t => E.cleanBase(t.base)));
  let bx = [];
  try { bx = (await X.bingxTickers()).filter(t => t.qv >= 5e5 && !onB.has(E.cleanBase(t.base))).sort((a, b) => b.qv - a.qv).slice(0, N_BINGX); } catch (e) { }
  const list = [...bn, ...bx];
  const btc = await X.binanceKlines('BTCUSDT', BARS, E.HISTORY);
  // świece dzienne: pobieramy wszystko od razu i liczymy nastrój rynku (odsetek coinów nad EMA50)
  let kl = null, breadth = null;
  if (BARS === '1d') {
    kl = {}; for (const t of list) { try { kl[t.ex + t.sym] = await X.getKlines(t.ex, t.sym, '1d', E.HISTORY); } catch (e) { } }
    const days = new Map();
    for (const k of Object.values(kl)) {
      if (!k || k.c.length < 60) continue;
      let e = k.c[0]; const a = 2 / 51;
      for (let i = 0; i < k.c.length; i++) { e = i ? a * k.c[i] + (1 - a) * e : e; if (i < 50) continue; const d = days.get(k.t[i]) || [0, 0]; d[0] += k.c[i] > e ? 1 : 0; d[1]++; days.set(k.t[i], d); }
    }
    const need = Math.min(15, Math.ceil(Object.keys(kl).length / 2));
    const ts = [...days.keys()].filter(t => days.get(t)[1] >= need).sort((a, b) => a - b);
    const br = ts.map(t => days.get(t)[0] / days.get(t)[1]);
    breadth = { t: ts.slice(5), v: br.slice(5).map((b, i) => [b - 0.5, b - br[i]]) };
    if (breadth.t.length < 100) breadth = null;
    console.log(`Nastrój rynku: ${ts.length} dni${br.length ? `, teraz ${(br[br.length - 1] * 100).toFixed(0)}% coinów nad EMA50` : ''}`);
  }
  console.log(`Horyzont ${IV} (H=${H}) · coinów: ${list.length}`);
  const T = Math.max(1, Math.min(4, os.cpus().length));
  const shards = Array.from({ length: T }, () => []); list.forEach((t, i) => shards[i % T].push(t));
  const coins = [];
  await Promise.all(shards.map(sh => new Promise(res => {
    const w = new Worker(__filename, { workerData: { list: sh, btc, kl: kl ? Object.fromEntries(sh.map(t => [t.ex + t.sym, kl[t.ex + t.sym]])) : null, breadth } });
    w.on('message', m => coins.push(m)); w.on('exit', res); w.on('error', e => { console.log('wątek:', e.message); res(); });
  })));
  console.log(`Policzone coiny: ${coins.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);

  if (AUTO) return autoReport(coins, H, t0);
  const variants = {};
  for (const name of ['base', 'btc', 'btcext', 'mtf', 'mtfbtc', 'breadth', 'btcbreadth']) {
    const cr = coins.filter(c => c.recs[name]).map(c => ({ coin: c.coin, L: c.recs[name].L, S: c.recs[name].S }));
    if (cr.length) variants[name] = cr;
  }

  const byLift = (a, b) => b.lift - a.lift || b.p - a.p;
  const byP = (a, b) => b.p - a.p;
  const passed = x => x.rskill !== null && x.rskill > 0;
  const top = x => x.rskill !== null && x.rskill >= 0.01 && x.p > BE + 0.02 && x.lift >= 0.05;
  const against = x => x.bt !== null && x.bt !== undefined && ((x.side === 'L' && x.bt < -0.5) || (x.side === 'S' && x.bt > 0.5));
  const withBtcOrFlat = x => x.bt === null || x.bt === undefined || !((x.side === 'L' && x.bt < -0.5) || (x.side === 'S' && x.bt > 0.5));
  const withBtc = x => x.bt !== null && x.bt !== undefined && ((x.side === 'L' && x.bt > 0.5) || (x.side === 'S' && x.bt < -0.5));
  const rules = {
    'APLIKACJA (test zdany, p>próg, wg przewagi)': { filter: x => passed(x) && x.p > BE + 0.02, sort: byLift, top: 10 },
    'jw. ale wg procentu': { filter: x => passed(x) && x.p > BE + 0.02, sort: byP, top: 10 },
    'jw. + przewaga ≥5 pkt': { filter: x => passed(x) && x.p > BE + 0.02 && x.lift >= 0.05, sort: byLift, top: 10 },
    'jw. + przewaga ≥8 pkt': { filter: x => passed(x) && x.p > BE + 0.02 && x.lift >= 0.08, sort: byLift, top: 10 },
    'test mocniej zdany (skill ≥1%)': { filter: x => x.rskill !== null && x.rskill >= 0.01 && x.p > BE + 0.02, sort: byLift, top: 10 },
    'bez testu (tylko p>próg)': { filter: x => x.p > BE + 0.02, sort: byLift, top: 10 },
    'TOP 5 zamiast 10': { filter: x => passed(x) && x.p > BE + 0.02, sort: byLift, top: 5 },
    'p ≥ 45%': { filter: x => passed(x) && x.p >= 0.45, sort: byLift, top: 10 },
    'przewaga ≥5 pkt + skill ≥1%': { filter: x => x.rskill !== null && x.rskill >= 0.01 && x.p > BE + 0.02 && x.lift >= 0.05, sort: byLift, top: 10 },
    'NOWY TOP (≥5 pkt + skill ≥1%)': { filter: top, sort: byLift, top: 10 },
    'NOWY TOP bez scenariuszy pod prąd BTC': { filter: x => top(x) && !against(x), sort: byLift, top: 10 },
    'NOWY TOP + p ≥ 60%': { filter: x => top(x) && x.p >= 0.6, sort: byLift, top: 10 },
    'NOWY TOP + p ≥ 55%': { filter: x => top(x) && x.p >= 0.55, sort: byLift, top: 10 },
    'NOWY TOP, BTC silny trend (|t|>2) – tylko w jego stronę': { filter: x => top(x) && !(x.bt !== null && x.bt !== undefined && ((x.side === 'L' && x.bt < -2) || (x.side === 'S' && x.bt > 2))), sort: byLift, top: 10 },
    'NOWY TOP z trendem coina': { filter: x => top(x) && x.ct !== null && ((x.side === 'L' && x.ct > 0) || (x.side === 'S' && x.ct < 0)), sort: byLift, top: 10 },
    'NOWY TOP z trendem coina i BTC': { filter: x => top(x) && x.ct !== null && withBtcOrFlat(x) && ((x.side === 'L' && x.ct > 0) || (x.side === 'S' && x.ct < 0)), sort: byLift, top: 10 },
    'NOWY TOP zgodnie z nastrojem rynku': { filter: x => top(x) && x.br !== null && ((x.side === 'L' && x.br > 0) || (x.side === 'S' && x.br < 0)), sort: byLift, top: 10 },
    'NOWY TOP tylko zgodnie z BTC': { filter: x => top(x) && withBtc(x), sort: byLift, top: 10 },
    'APLIKACJA bez pod prąd BTC': { filter: x => passed(x) && x.p > BE + 0.02 && !against(x), sort: byLift, top: 10 },
    'przewaga ≥6 pkt': { filter: x => passed(x) && x.p > BE + 0.02 && x.lift >= 0.06, sort: byLift, top: 10 },
  };
  console.log(`\nUkład ${MODE} (cel ${LEV[0]}×ATR, stop ${LEV[1]}×ATR) · próg opłacalności ${(BE * 100).toFixed(0)}% · wynik R: cel +${RW}, stop −1, brak rozstrzygnięcia 0`);
  for (const [vn, cr] of Object.entries(variants)) {
    console.log(`\n=== MODEL: ${vn} ===`);
    for (const [rn, rule] of Object.entries(rules)) {
      if (!/^NOWY TOP|^APLIKACJA/.test(rn)) continue;
      const r = simulate(cr, rule, H);
      console.log(`${rn.padEnd(46)} scenariuszy ${String(r.n).padStart(5)} | trafione ${(r.hit * 100).toFixed(1)}% | średnio ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(3)}R`);
    }
  }
  console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

// ---------- Tryb auto: porównanie stałych układów z automatycznym wyborem ----------
function autoReport(coins, H, t0) {
  const RWL = { big: 2, equal: 1, safe: 0.5 }, BEL = { big: 1 / 3, equal: 0.5, safe: 2 / 3 };
  const ev = x => x.p * (x.rw + 1) - 1;   // oczekiwany wynik w R przy tej szansie
  const names = [...new Set(coins.flatMap(c => Object.keys(c.recs).map(k => k.split('|')[0])))];
  const top = x => x.rskill !== null && x.rskill >= 0.01 && x.p > x.be + 0.02 && x.p - x.prior >= 0.05;
  const trend = x => x.ct !== null && ((x.side === 'L' && x.ct > 0) || (x.side === 'S' && x.ct < 0));
  for (const nm of names) {
    // kandydaci: czas → coin → lista (układ × kierunek)
    const byT = new Map();
    for (const c of coins) for (const ly of ['big', 'equal', 'safe']) {
      const R = c.recs[nm + '|' + ly]; if (!R) continue;
      for (const side of ['L', 'S']) for (const r of R[side]) {
        if (!byT.has(r.t)) byT.set(r.t, new Map()); const m = byT.get(r.t);
        if (!m.has(c.coin)) m.set(c.coin, []);
        m.get(c.coin).push({ coin: c.coin, side, ly, rw: RWL[ly], be: BEL[ly], ...r, lift: r.p - r.prior });
      }
    }
    const times = [...byT.keys()].sort((a, b) => a - b);
    const sim = (allow, pick, sort, extra = () => true) => {
      const blocked = new Map(); let win = 0, loss = 0, none = 0, sumR = 0; const used = { big: 0, equal: 0, safe: 0 };
      for (const t of times) {
        const cands = [];
        for (const list of byT.get(t).values()) {
          const ok = list.filter(x => allow(x.ly) && top(x) && extra(x)); if (!ok.length) continue;
          cands.push(ok.sort(pick)[0]);
        }
        cands.sort(sort); let taken = 0;
        for (const x of cands) {
          if (taken >= 10) break; const key = x.coin + x.side; if ((blocked.get(key) || 0) > t) continue;
          blocked.set(key, t + H * STEP); taken++; used[x.ly]++;
          if (x.y === 1) { win++; sumR += x.rw; } else if (x.y === -1) { loss++; sumR -= 1; } else none++;
        }
      }
      const n = win + loss + none;
      return { n, hit: win + loss ? win / (win + loss) : 0, avgR: n ? sumR / n : 0, used };
    };
    const byLift = (a, b) => b.lift - a.lift || b.p - a.p, byEV = (a, b) => ev(b) - ev(a) || b.lift - a.lift;
    const rows = [
      ['stały 2:1', l => l === 'big', byLift, byLift],
      ['stały 1:1', l => l === 'equal', byLift, byLift],
      ['stały 1:2', l => l === 'safe', byLift, byLift],
      ['AUTO: najlepszy układ coina, TOP wg zysku', () => true, byEV, byEV],
      ['AUTO: najlepszy układ coina, TOP wg przewagi', () => true, byEV, byLift],
      ['AUTO tylko 2:1 lub 1:1, wg zysku', l => l !== 'safe', byEV, byEV],
    ];
    console.log(`\n=== MODEL: ${nm} · horyzont ${IV} ===`);
    for (const tr of [false, true]) {
      if (tr) console.log('--- tylko scenariusze zgodne z trendem coina ---');
      for (const [label, allow, pick, sort] of rows) {
        const r = sim(allow, pick, sort, tr ? trend : undefined);
        console.log(`${label.padEnd(44)} scen. ${String(r.n).padStart(5)} | trafione ${(r.hit * 100).toFixed(1)}% | średnio ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(3)}R | układy 2:1/1:1/1:2: ${r.used.big}/${r.used.equal}/${r.used.safe}`);
      }
    }
  }
  console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

if (isMainThread) main().catch(e => { console.error(e); process.exit(1); });
else worker();
