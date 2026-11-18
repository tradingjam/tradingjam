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
const AUTO = MODE === 'auto';
const EXITS = MODE === 'exits';
const REV = MODE === 'reversal';
const TREND = MODE === 'trend';
const PUMP = MODE === 'pumpfade';          // pumpfade: short na coinach po dużym wystrzale, które już spadają od szczytu            // trend: wybicie z kanału + ciągnięty stop (bez stałego celu)          // reversal: reguła „odwrócenie trendu” (bez modelu), jak planowane konto F          // exits: porównanie sposobów zamykania pozycji (cel / stop na wejście / ciągnięcie zysku)            // auto: model sam wybiera układ (2:1, 1:1, 1:2) dla każdego scenariusza
const LEV = LEVS[AUTO || EXITS || REV || TREND || PUMP ? 'big' : MODE]; // [cel, stop] w ATR
// model jak w aplikacji dla danego horyzontu
const PROD = { '1h': 'mtfbtc', '4h': 'btc', '1d': 'btc', '30d': 'base' }[IV];
const RW = LEV[0] / LEV[1];                 // ile R daje trafiony cel
const VALID_N = 1000, REFIT = 200, BE = LEV[1] / (LEV[0] + LEV[1]);

// ---------- Wątek: dane i predykcje per coin ----------
function features(k, ctx, k4) {
  const { F, raw } = I.buildFeatures(k, ctx, k4);
  const Z = I.zscore(F); Z.F = F; // Z.F: surowe cechy do normalizacji walk-forward
  return { Z, raw };
}
function labels(k, raw, H, lev = LEV) {
  const tg = lev[0] * SCALE, st = lev[1] * SCALE;
  return { L: I.outcomes(k, raw, H, tg, st), S: I.outcomes(k, raw, H, st, tg).map(y => (y === null ? null : -y)) };
}
// walk-forward per coin: zwraca dla punktów testu p, prior (z przeszłości) i wynik
function walk(Z, Y, lab, H, l2, btcAt) {
  const out = []; if (lab.length < 500) return out;
  const vs = lab.slice(Math.max(300 + H, lab.length - VALID_N));
  let model = null, fittedAt = -Infinity, bm = 0, bb = 0, n = 0; const fz = Z.F ? I.foldZ(Z.F) : null; let Zc = Z;
  for (const t of vs) {
    if (t - fittedAt >= REFIT) { if (fz) Zc = fz(t); model = I.fitModel(Zc, Y, lab.filter(i => i <= t - H), model && model.W, l2); fittedAt = t; }
    const p = I.predictP(model, Zc[t]);
    const rskill = n >= 100 && bb > 0 ? 1 - bm / bb : null;
    out.push({ i: t, p: p[0], prior: model.prior[0], y: Y[t], rskill, bt: btcAt ? btcAt(t) : null, ct: walk.raw && walk.raw[t] ? walk.raw[t].trend : null, br: walk.br ? walk.br(t) : null });
    // skill liczony tylko z wcześniejszych punktów testu (bez zaglądania w przyszłość)
    if (t + H <= vs[vs.length - 1]) { bm += I.brier(p, Y[t]); bb += I.brier(model.prior, Y[t]); n++; }
  }
  return out;
}
const extCtx = E.extCtx;
// Wynik pozycji w R dla różnych sposobów zamykania. Stop 1×ATR, cel 2×ATR. Gdy w jednej świecy padłby i stop,
// i inny poziom – liczymy stop (ostrożnie). Koszty: prowizja + poślizg 0,1% na stronę.
const EXIT_NAMES = ['zamknięcie na celu (teraz)', 'stop na wejście po +1R', 'połowa na celu, reszta ciągnięta', 'całość ciągnięta od celu', 'połowa na celu, reszta ciągnięta, max 2× czas'];
const WIDE = [[1, 2], [1.5, 3], [2, 4], [1.5, 1.5], [2, 2], [2, 3]];
function exitsAt(k, i, atr, long, H) {
  const e = k.c[i], d = atr, sg = long ? 1 : -1, n = k.c.length;
  if (!(d > 0) || i + H >= n) return null;
  const cost = 0.002 * e / d; // koszty w R
  const fav = j => (long ? k.h[j] - e : e - k.l[j]) / d, adv = j => (long ? e - k.l[j] : k.h[j] - e) / d, at = j => sg * (k.c[j] - e) / d;
  let xj = 0;
  const run = (mode, maxH) => {
    let stop = -1, half = false, best = 0, banked = 0, size = 1;
    const end = Math.min(n - 1, i + maxH);
    for (let j = i + 1; j <= end; j++) {
      xj = j;
      if (-adv(j) <= stop) return banked + size * stop;           // stop (także przesunięty)
      const f = fav(j); best = Math.max(best, f);
      if (mode === 0 && f >= 2) return 2;
      if (mode === 1) { if (f >= 2) return 2; if (best >= 1) stop = Math.max(stop, 0); }
      if (mode === 2 || mode === 4) {
        if (!half && f >= 2) { half = true; banked = 1; size = 0.5; stop = 1; }
        if (half) stop = Math.max(stop, best - 1);
        if (j === i + H && mode === 2) return banked + size * at(j);
      }
      if (mode === 3) { if (best >= 2) stop = Math.max(stop, best - 1); }
      if (j === i + H && mode !== 4 && mode !== 3) return banked + size * at(j);
    }
    xj = end; return banked + size * at(end);
  };
  const raw = [], bars = [];
  for (const [m, mh] of [[0, H], [1, H], [2, H], [3, 2 * H], [4, 2 * H]]) { raw.push(run(m, mh)); bars.push(xj - i); }
  // inne odległości stopu i celu (w ATR): wynik w R liczony względem tego stopu, koszty też
  const alt = {};
  for (const [sl, tp] of WIDE) {
    let res = null;
    const end = Math.min(n - 1, i + H);
    for (let j = i + 1; j <= end; j++) {
      if (adv(j) >= sl) { res = -1; break; }
      if (fav(j) >= tp) { res = tp / sl; break; }
    }
    if (res === null) res = at(end) / sl;
    alt[sl + '/' + tp] = +(res - cost / sl).toFixed(4);
  }
  const out = raw.map(r => +(r - cost).toFixed(4)); out.cost = cost; out.gross = raw; out.bars = bars; out.sf = d / e; out.alt = alt; return out;
}
// Reguła odwrócenia trendu (tylko dane z zamkniętej świecy i), ta sama co w bocie (konto F):
// LONG: cena ≥ 1,5 ATR pod EMA50, EMA20 zawraca w górę, cena nad SMA10, RSI 45–65, wolumen wyraźnie powyżej średniej (wskaźnik ≥ 1,05 – górne ok. 30%).
// Stop 1,5 ATR (min. 1,3% ceny), cel = EMA50 (najwyżej 4× stop), wymagane cel ≥ 1,5× stop. SHORT lustrzanie.
const REV_VARIANTS = {
  'ścisła': { tr: 1.5, vol: 1.05, rsiL: [45, 65], rr: 1.5 },
  'średnia': { tr: 1.0, vol: 1.0, rsiL: [40, 65], rr: 1.2 },
  'luźna': { tr: 0.7, vol: 0, rsiL: [38, 70], rr: 1.0 },
};
function reversalAt(k, raw, sma10, i, P = REV_VARIANTS['ścisła']) {
  const r = raw[i]; if (!r || !(r.atr > 0)) return null;
  const px = k.c[i], ema50 = px - r.trend * r.atr;
  let side = null;
  if (r.trend <= -P.tr && r.slope > 0 && px > sma10[i] && r.rsi >= P.rsiL[0] && r.rsi <= P.rsiL[1] && r.volRatio >= P.vol) side = 'L';
  else if (r.trend >= P.tr && r.slope < 0 && px < sma10[i] && r.rsi >= 100 - P.rsiL[1] && r.rsi <= 100 - P.rsiL[0] && r.volRatio >= P.vol) side = 'S';
  if (!side) return null;
  const stop = Math.max(1.5 * r.atr, px * 0.013), tgt = Math.min(Math.abs(ema50 - px), 4 * stop);
  if (tgt < P.rr * stop) return null;
  return { side, stop, tgt };
}
// Strategia trendowa: LONG gdy zamknięcie wybija najwyższy szczyt z N poprzednich świec, cena nad EMA50 i EMA20 rośnie
// (SHORT lustrzanie). Stop startowy m×ATR (min. 1,3% ceny), potem ciągnięty: najlepsze zamknięcie − m×ATR. Bez stałego celu,
// maks. 3× horyzont. Wejście po zamknięciu świecy sygnału, w jednej świecy dotknięcie stopu liczone przed nowym szczytem.
const TREND_VARIANTS = { 'kanał 20, stop 2 ATR': { N: 20, m: 2 }, 'kanał 20, stop 3 ATR': { N: 20, m: 3 }, 'kanał 55, stop 3 ATR': { N: 55, m: 3 } };
function trendTrades(k, raw, H, P) {
  const n = k.c.length, out = []; let busy = -1;
  for (let i = Math.max(60, P.N); i < n - 2; i++) {
    if (i <= busy) continue; const r = raw[i]; if (!r || !(r.atr > 0)) continue;
    let hi = -Infinity, lo = Infinity; for (let j = i - P.N; j < i; j++) { if (k.h[j] > hi) hi = k.h[j]; if (k.l[j] < lo) lo = k.l[j]; }
    let L = null;
    if (k.c[i] > hi && r.trend > 0 && r.slope > 0) L = true; else if (k.c[i] < lo && r.trend < 0 && r.slope < 0) L = false;
    if (L === null) continue;
    const e = k.c[i], d = Math.max(P.m * r.atr, e * 0.013), atr = r.atr;
    let stop = L ? e - d : e + d, best = e, j, exit = null;
    for (j = i + 1; j < n && j <= i + 3 * H; j++) {
      if (L ? k.l[j] <= stop : k.h[j] >= stop) { exit = (L ? Math.min(stop, k.o[j]) : Math.max(stop, k.o[j])); break; }
      best = L ? Math.max(best, k.c[j]) : Math.min(best, k.c[j]);
      const ns = L ? best - P.m * atr : best + P.m * atr; if (L ? ns > stop : ns < stop) stop = ns;
    }
    if (exit === null) { j = Math.min(j, n - 1); exit = k.c[j]; }
    out.push({ t: k.t[i], side: L ? 'L' : 'S', r: (L ? exit - e : e - exit) / d - 0.002 * e / d, bars: j - i }); busy = j;
  }
  return out;
}
// Short po wystrzale („pump and dump”): w oknie W świec szczyt ≥ X× dołka sprzed szczytu, cena spadła już ≥ Y od szczytu,
// ale jest wciąż ≥ 30% nad dołkiem; cena pod EMA20, EMA20 spada, zamknięcie pod SMA10. Stop m×ATR (min. 1,3%),
// potem ciągnięty od najlepszego zamknięcia; bez stałego celu, maks. 3× horyzont. Jedna pozycja na coin naraz.
const PUMP_VARIANTS = { 'wystrzał ≥ 2×, spadek ≥ 30%': { X: 2, Y: 0.3, m: 2.5 }, 'wystrzał ≥ 3×, spadek ≥ 40%': { X: 3, Y: 0.4, m: 2.5 }, 'wystrzał ≥ 2×, spadek ≥ 30%, stop 4 ATR': { X: 2, Y: 0.3, m: 4 } };
function pumpTrades(k, raw, H, P, W) {
  const n = k.c.length, out = []; let busy = -1; const sma10 = new Array(n).fill(null);
  for (let i = 9; i < n; i++) { let a = 0; for (let j = i - 9; j <= i; j++) a += k.c[j]; sma10[i] = a / 10; }
  for (let i = W + 20; i < n - 2; i++) {
    if (i <= busy) continue; const r = raw[i]; if (!r || !(r.atr > 0)) continue;
    let pk = -Infinity, pkI = -1; for (let j = i - W; j < i; j++) if (k.h[j] > pk) { pk = k.h[j]; pkI = j; }
    let lo = Infinity; for (let j = Math.max(0, pkI - W); j < pkI; j++) if (k.l[j] < lo) lo = k.l[j];
    const px = k.c[i];
    if (!(pk / lo >= P.X && px <= pk * (1 - P.Y) && px >= lo * 1.3 && r.slope < 0 && px < sma10[i] && r.trend < 0)) continue;
    const d = Math.max(P.m * r.atr, px * 0.013), atr = r.atr;
    let stop = px + d, best = px, j, exit = null;
    for (j = i + 1; j < n && j <= i + 3 * H; j++) {
      if (k.h[j] >= stop) { exit = Math.max(stop, k.o[j]); break; }
      best = Math.min(best, k.c[j]); const ns = best + P.m * atr; if (ns < stop) stop = ns;
    }
    if (exit === null) { j = Math.min(j, n - 1); exit = k.c[j]; }
    out.push({ t: k.t[i], side: 'S', r: (px - exit) / d - 0.002 * px / d, bars: j - i }); busy = j;
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
      if (PUMP) {
        const f = features(k); const trades = []; const W = BARS === '1d' ? 60 : IV === '4h' ? 180 : 360;
        for (const [vn, P] of Object.entries(PUMP_VARIANTS)) for (const x of pumpTrades(k, f.raw, H, P, W)) trades.push({ ...x, v: vn });
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs: { rev: trades }, pool: null }); continue;
      }
      if (TREND) {
        const f = features(k); const trades = [];
        for (const [vn, P] of Object.entries(TREND_VARIANTS)) for (const x of trendTrades(k, f.raw, H, P)) trades.push({ ...x, v: vn });
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs: { rev: trades }, pool: null }); continue;
      }
      if (REV) {
        const f = features(k); const raw = f.raw, n = k.c.length, sma10 = new Array(n).fill(null);
        for (let i = 9; i < n; i++) { let a = 0; for (let j = i - 9; j <= i; j++) a += k.c[j]; sma10[i] = a / 10; }
        const trades = [];
        for (const [vn, P] of Object.entries(REV_VARIANTS)) { let busy = -1;
        for (let i = 60; i < n - H; i++) { // reguła bez uczenia – cała dostępna historia
          if (i <= busy) continue;
          const sg = reversalAt(k, raw, sma10, i, P); if (!sg) continue;
          const e = k.c[i], L = sg.side === 'L', up = L ? e + sg.tgt : e + sg.stop, dn = L ? e - sg.stop : e - sg.tgt;
          let res = null, j;
          for (j = i + 1; j <= i + H; j++) { const hu = k.h[j] >= up, hd = k.l[j] <= dn; if (hu && hd) { res = -1; break; } if (L ? hu : hd) { res = sg.tgt / sg.stop; break; } if (L ? hd : hu) { res = -1; break; } }
          if (res === null) { j = i + H; res = (L ? k.c[j] - e : e - k.c[j]) / sg.stop; }
          trades.push({ v: vn, t: k.t[i], side: sg.side, r: res - 0.002 * e / sg.stop, rr: sg.tgt / sg.stop }); busy = j;
        } }
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs: { rev: trades }, pool: null }); continue;
      }
      if (EXITS) {
        const f = IV === '1h' ? features(k, btcCtx, k4) : features(k, btcCtx);
        run(PROD, f.Z, f.raw, 0.3, LEVS.big);
        for (const side of ['L', 'S']) for (const r of recs[PROD][side]) { const rw = f.raw[r.i]; r.ex = rw ? exitsAt(k, r.i, rw.atr * SCALE, side === 'L', H) : null; if (r.ex) { r.cost = r.ex.cost; r.gross = r.ex.gross; r.bars = r.ex.bars; r.sf = r.ex.sf; r.alt = r.ex.alt; r.ex = [...r.ex]; } }
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs, pool: null }); continue;
      }
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
      if (BARS !== '1d' && workerData.btcD) {
        try {
          const kd = await X.getKlines(t.ex, t.sym, '1d', E.HISTORY);
          const cx = E.withDailyExt(btcCtx, kd, workerData.btcD);
          if (cx !== btcCtx) {
            if (k4) { const f = features(k, cx, k4); run('mtfbtcext', f.Z, f.raw, 0.3); }
            else { const f = features(k, cx); run('btcext', f.Z, f.raw, 0.3); }
          }
        } catch (e) { }
      }
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

// Kalibracja walk-forward: p' = sigmoid(a·logit(p) + b·logit(prior) + c), dopasowana na wspólnych
// scenariuszach wszystkich coinów, których wynik był już znany (t ≤ chwila − H). Uczy model, ile jego procent jest wart.
function calibrate(cr, H) {
  const lg = x => { const q = Math.min(0.99, Math.max(0.01, x)); return Math.log(q / (1 - q)); };
  const all = []; for (const c of cr) for (const side of ['L', 'S']) for (const r of c[side]) all.push(r);
  all.sort((a, b) => a.t - b.t);
  const map = new Map(); let w = [1, 0, 0];
  const fit = tr => { // kilka kroków Newtona na regresji logistycznej (3 parametry, lekka regularizacja do [1,0,0])
    let W = [1, 0, 0];
    for (let it = 0; it < 15; it++) {
      const g = [0, 0, 0], Hm = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(r => r.map(v => v * 5));
      for (let d = 0; d < 3; d++) g[d] = 5 * (W[d] - [1, 0, 0][d]);
      for (const r of tr) { const x = [lg(r.p), lg(r.prior), 1]; const z = W[0] * x[0] + W[1] * x[1] + W[2]; const q = 1 / (1 + Math.exp(-z)); const y = r.y === 1 ? 1 : 0;
        for (let a = 0; a < 3; a++) { g[a] += (q - y) * x[a]; for (let b = 0; b < 3; b++) Hm[a][b] += q * (1 - q) * x[a] * x[b]; } }
      // rozwiązanie 3×3
      const A = Hm.map((r, i) => [...r, g[i]]);
      for (let i = 0; i < 3; i++) { let m = i; for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[m][i])) m = k; [A[i], A[m]] = [A[m], A[i]];
        for (let k = 0; k < 3; k++) if (k !== i) { const f = A[k][i] / A[i][i]; for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j]; } }
      const step = A.map((r, i) => r[3] / r[i]); W = W.map((v, i) => v - step[i]);
    }
    return W;
  };
  let ptr = 0; const tStart = all.length ? all[0].t : 0; let nextFit = tStart;
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.t >= nextFit) {
      const tr = []; for (const x of all) { if (x.t > r.t - H * STEP) break; tr.push(x); }
      w = tr.length >= 1000 ? fit(tr.length > 20000 ? tr.slice(-20000) : tr) : [1, 0, 0];
      nextFit = r.t + REFIT * STEP;
    }
    const z = w[0] * lg(r.p) + w[1] * lg(r.prior) + w[2];
    map.set(r, 1 / (1 + Math.exp(-z)));
  }
  return cr.map(c => ({ coin: c.coin, L: c.L.map(r => ({ ...r, p: map.get(r) })), S: c.S.map(r => ({ ...r, p: map.get(r) })) }));
}

async function main() {
  const t0 = Date.now(); const H = E.CFG[IV].H;
  const bn = (await X.binanceTickers()).filter(t => t.qv >= 3e6).sort((a, b) => b.qv - a.qv).slice(0, N_BINANCE);
  const onB = new Set(bn.map(t => E.cleanBase(t.base)));
  let bx = [];
  try { bx = (await X.bingxTickers()).filter(t => t.qv >= 5e5 && !onB.has(E.cleanBase(t.base))).sort((a, b) => b.qv - a.qv).slice(0, N_BINGX); } catch (e) { }
  const list = [...bn, ...bx];
  const btc = await X.binanceKlines('BTCUSDT', BARS, E.HISTORY);
  const btcD = BARS === '1d' ? null : await X.binanceKlines('BTCUSDT', '1d', E.HISTORY);
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
    const w = new Worker(__filename, { workerData: { list: sh, btc, btcD, kl: kl ? Object.fromEntries(sh.map(t => [t.ex + t.sym, kl[t.ex + t.sym]])) : null, breadth } });
    w.on('message', m => coins.push(m)); w.on('exit', res); w.on('error', e => { console.log('wątek:', e.message); res(); });
  })));
  console.log(`Policzone coiny: ${coins.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);

  if (AUTO) return autoReport(coins, H, t0);
  if (REV || TREND || PUMP) {
    const VARS = PUMP ? PUMP_VARIANTS : TREND ? TREND_VARIANTS : REV_VARIANTS;
    const ALL = coins.flatMap(c => (c.recs.rev || []).map(x => ({ ...x, coin: c.coin }))).sort((a, b) => a.t - b.t);
    for (const vn of Object.keys(VARS)) { const all = ALL.filter(x => x.v === vn);
    const tEnd = all.length ? all[all.length - 1].t : 0;
    const row = (lbl, P) => { const w = P.filter(x => x.r > 0).length, av = P.reduce((a, x) => a + x.r, 0) / (P.length || 1);
      console.log(`${lbl.padEnd(34)} ${String(P.length).padStart(5)} transakcji · na plus ${(w / (P.length || 1) * 100).toFixed(0)}% · średnio ${av >= 0 ? '+' : ''}${av.toFixed(2)}R po kosztach`); };
    const days = all.length ? (tEnd - all[0].t) / 864e5 : 0;
    console.log(`\n=== ${PUMP ? 'Short po wystrzale' : TREND ? 'Z trendem' : 'Odwrócenie trendu'} – wersja ${vn} · ${coins.length} coinów · ok. ${days.toFixed(0)} dni ===`);
    row('wszystkie', all); row('LONG', all.filter(x => x.side === 'L')); row('SHORT', all.filter(x => x.side === 'S'));
    const h = all.length >> 1; row('1. połowa okresu', all.slice(0, h)); row('2. połowa okresu', all.slice(h));
    row('ostatnie 3 tygodnie', all.filter(x => x.t >= tEnd - 21 * 864e5));
    if (TREND || PUMP) { const R = all.map(x => x.r).sort((a, b) => a - b); console.log(`największa wygrana ${R.length ? R[R.length - 1].toFixed(1) : 0}R · średni czas ${(all.reduce((a, x) => a + x.bars, 0) / (all.length || 1)).toFixed(0)} świec · suma ${R.reduce((a, b) => a + b, 0).toFixed(0)}R`); }
    else console.log(`średni stosunek cel/stop: ${(all.reduce((a, x) => a + x.rr, 0) / (all.length || 1)).toFixed(2)}`); }
    console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`); return;
  }
  if (EXITS) {
    const cr = coins.filter(c => c.recs[PROD]).map(c => ({ coin: c.coin, L: c.recs[PROD].L.filter(r => r.ex), S: c.recs[PROD].S.filter(r => r.ex) }));
    const byT = new Map();
    for (const c of cr) for (const side of ['L', 'S']) for (const r of c[side]) {
      if (!byT.has(r.t)) byT.set(r.t, new Map()); const m = byT.get(r.t); const prev = m.get(c.coin);
      const cand = { coin: c.coin, side, ...r, lift: r.p - r.prior };
      if (cand.rskill !== null && cand.rskill >= 0.01 && cand.p > BE + 0.02 && cand.lift >= 0.05 && (!prev || cand.lift > prev.lift)) m.set(c.coin, cand);
    }
    const times = [...byT.keys()].sort((a, b) => a - b); const blocked = new Map(); const picks = [];
    for (const t of times) { const cs = [...byT.get(t).values()].sort((a, b) => b.lift - a.lift); let n = 0;
      for (const x of cs) { if (n >= 10) break; const key = x.coin + x.side; if ((blocked.get(key) || 0) > t) continue; blocked.set(key, t + H * STEP); x.rank = n; n++; picks.push(x); } }
    console.log(`\nSposoby zamykania · model ${PROD} · ${picks.length} scenariuszy TOP 10 (2:1, z kosztami 0,1% na stronę)`);
    const costs = picks.map(x => x.cost).sort((a, b) => a - b);
    console.log(`Koszty w R: mediana ${costs[costs.length >> 1].toFixed(3)} · 90% scenariuszy poniżej ${costs[Math.floor(costs.length * 0.9)].toFixed(3)} · max ${costs[costs.length - 1].toFixed(2)}`);
    for (const [lbl, sel] of [['wszystkie', () => true], ['koszt < 0,15R (stop dalej niż ~1,3%)', x => x.cost < 0.15]]) {
      const P = picks.filter(sel); console.log(`--- ${lbl}: ${P.length} scen. ---`);
      EXIT_NAMES.forEach((nm, q) => {
        const R = P.map(x => x.ex[q]), G = P.map(x => x.ex[q] + x.cost); const av = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
        const h1 = R.slice(0, R.length >> 1), h2 = R.slice(R.length >> 1);
        console.log(`${nm.padEnd(48)} netto ${av(R) >= 0 ? '+' : ''}${av(R).toFixed(3)}R | bez kosztów ${av(G) >= 0 ? '+' : ''}${av(G).toFixed(3)}R | na plus ${(R.filter(v => v > 0).length / (R.length || 1) * 100).toFixed(0)}% | połowy ${av(h1).toFixed(2)} / ${av(h2).toFixed(2)}`);
      });
    }
    // ---- Odległość stopu × ostrzejsza selekcja: trafienia i średni wynik po kosztach ----
    {
      const sels = [['TOP 10 (teraz)', x => true], ['TOP 5', x => x.rank < 5], ['TOP 3', x => x.rank < 3], ['przewaga ≥ 8 pkt', x => x.lift >= 0.08], ['przewaga ≥ 10 pkt', x => x.lift >= 0.10], ['skill ≥ 3%', x => x.rskill >= 0.03]];
      console.log(`\n=== Stop i cel (w ATR) × selekcja · trafienia | średnio R po kosztach | liczba (stop min. 1,3%) ===`);
      console.log('selekcja'.padEnd(20) + WIDE.map(([a, b]) => `stop ${a}/cel ${b}`.padEnd(26)).join(''));
      for (const [sn, sf] of sels) {
        let line = sn.padEnd(20);
        for (const [sl, tp] of WIDE) {
          const P = picks.filter(x => sf(x) && x.alt && x.sf * sl >= 0.013);
          const R = P.map(x => x.alt[sl + '/' + tp]); const w = R.filter(v => v > 0).length;
          const av = R.reduce((a, b) => a + b, 0) / (R.length || 1);
          line += `${(w / (R.length || 1) * 100).toFixed(0)}% ${av >= 0 ? '+' : ''}${av.toFixed(2)}R n${R.length}`.padEnd(26);
        }
        console.log(line);
      }
    }
    // ---- Long vs short, całość i ostatnie ~3 tygodnie (stop min. 1,3%, cel 2:1, po kosztach) ----
    {
      const tEnd = picks.length ? picks[picks.length - 1].t : 0, recent = tEnd - 21 * 864e5;
      const row = (lbl, P) => { const R = P.map(x => x.alt['1/2']); const w = R.filter(v => v > 0).length; const av = R.reduce((a, b) => a + b, 0) / (R.length || 1);
        console.log(`${lbl.padEnd(46)} ${String(R.length).padStart(4)} scen. · na plus ${(w / (R.length || 1) * 100).toFixed(0)}% · średnio ${av >= 0 ? '+' : ''}${av.toFixed(2)}R`); };
      console.log(`\n=== LONG vs SHORT (zielone, stop ≥ 1,3%) ===`);
      const liveFrom = Date.parse('2026-11-14T12:00:00Z'), liveTo = Date.parse('2026-11-16T19:40:00Z');
      console.log('--- okres, w którym grał bot na żywo (14.11 12:00 – 16.11 20:40, przed poprawkami) ---');
      for (const [sn, sf] of [['przewaga ≥ 5 pkt (jak bot wtedy)', x => true], ['przewaga ≥ 8 pkt', x => x.lift >= 0.08]]) for (const side of ['L', 'S', 'LS'])
        row(`${sn} · ${side === 'LS' ? 'razem' : side === 'L' ? 'LONG' : 'SHORT'}`, picks.filter(x => sf(x) && side.includes(x.side) && x.t >= liveFrom && x.t <= liveTo && x.alt && x.sf >= 0.013));
      const lp = picks.filter(x => x.t >= liveFrom && x.t <= liveTo);
      console.log('coiny w teście w tym okresie: ' + [...new Set(lp.map(x => x.coin.split(':')[1] + (x.side === 'L' ? '↑' : '↓')))].slice(0, 40).join(' '));
      for (const [sn, sf] of [['przewaga ≥ 5 pkt', x => true], ['przewaga ≥ 8 pkt', x => x.lift >= 0.08]]) for (const side of ['L', 'S']) for (const [pn, pf] of [['cały test', x => true], ['ostatnie 3 tyg.', x => x.t >= recent]]) {
        row(`${sn} · ${side === 'L' ? 'LONG ' : 'SHORT'} · ${pn}`, picks.filter(x => sf(x) && x.side === side && pf(x) && x.alt && x.sf >= 0.013));
      }
    }
    // ---- Symulacja portfela jak w bocie: limit pozycji, łączna dźwignia, koszty rynkowe vs zlecenia z limitem ----
    {
      const cand = new Map(); for (const x of picks) { if (!cand.has(x.t)) cand.set(x.t, []); cand.get(x.t).push(x); }
      const span = (times[times.length - 1] - times[0]) / (30 * 864e5);
      const sim = (maxN, lev, q, fee, maxDir = 99) => {
        let open = [], sumR = 0, n = 0, peak = 0, dd = 0; const closedR = [];
        for (const t of times) {
          open = open.filter(o => { if (o.end <= t) { closedR.push([o.end, o.r]); return false; } return true; });
          for (const x of cand.get(t) || []) {
            if (open.length >= maxN) break;
            if (x.sf < 0.013) continue;                                // stop min. 1,3% jak w aplikacji
            if (open.some(o => o.coin === x.coin)) continue;
            if (open.filter(o => o.side === x.side).length >= maxDir) continue; // limit pozycji w jednym kierunku
            const need = 0.01 / x.sf, used = open.reduce((a, o) => a + o.notional, 0);
            const frac = Math.min(1, (lev - used) / need); if (frac < 0.3) continue;
            const r = frac * (x.gross[q] - fee / x.sf);
            open.push({ coin: x.coin, side: x.side, end: t + x.bars[q] * STEP, r, notional: need * frac }); n++;
          }
        }
        for (const o of open) closedR.push([o.end, o.r]);
        closedR.sort((a, b) => a[0] - b[0]);
        for (const [, r] of closedR) { sumR += r; peak = Math.max(peak, sumR); dd = Math.max(dd, peak - sumR); }
        return { n, perMonth: sumR / span, nPer: n / span, dd };
      };
      console.log(`\n=== Limit pozycji w jednym kierunku (maks. 8 pozycji, dźwignia 3×, zlecenia rynkowe) ===`);
      for (const [q, qn] of [[0, 'zamknięcie na celu'], [3, 'ciągnięcie zysku']]) for (const md of [99, 6, 5, 4]) {
        const r = sim(8, 3, q, 0.002, md);
        console.log(`${qn.padEnd(19)} · ${md === 99 ? 'bez limitu' : 'maks. ' + md + ' w 1 stronę'} → ${r.nPer.toFixed(0).padStart(3)} transakcji/mies. · ${r.perMonth >= 0 ? '+' : ''}${r.perMonth.toFixed(1)}% mies. · najgłębszy spadek ${r.dd.toFixed(1)}%`);
      }
      console.log(`\n=== Portfel jak w bocie (ryzyko 1%/pozycję, okres ${span.toFixed(1)} mies.) ===`);
      for (const [q, qn] of [[0, 'zamknięcie na celu'], [3, 'ciągnięcie zysku']]) for (const [fee, fn] of [[0.002, 'zlecenia rynkowe 0,2%'], [0.0011, 'zlecenia z limitem ~0,11%']])
        for (const [mx, lv] of [[5, 3], [8, 3], [10, 3], [8, 5]]) {
          const r = sim(mx, lv, q, fee);
          console.log(`${qn.padEnd(19)} · ${fn.padEnd(26)} · max ${String(mx).padStart(2)} poz., dźwignia ${lv}× → ${r.nPer.toFixed(0).padStart(3)} transakcji/mies. · ${r.perMonth >= 0 ? '+' : ''}${r.perMonth.toFixed(1)}% mies. · najgłębszy spadek ${r.dd.toFixed(1)}%`);
        }
    }
    if (false) EXIT_NAMES.forEach((nm, q) => {
      const R = picks.map(x => x.ex[q]); const avg = R.reduce((a, b) => a + b, 0) / (R.length || 1);
      const plus = R.filter(v => v > 0).length / (R.length || 1); const sorted = [...R].sort((a, b) => a - b);
      // połowy okresu – czy wynik jest stabilny w czasie
      const h1 = R.slice(0, R.length >> 1), h2 = R.slice(R.length >> 1); const av = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
      console.log(`${nm.padEnd(48)} średnio ${avg >= 0 ? '+' : ''}${avg.toFixed(3)}R | na plus ${(plus * 100).toFixed(0)}% | najlepsza +${sorted[sorted.length - 1].toFixed(1)}R | 1. połowa ${av(h1).toFixed(3)} · 2. połowa ${av(h2).toFixed(3)}`);
    });
    console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`); return;
  }
  const variants = {};
  for (const name of ['base', 'btc', 'btcext', 'mtf', 'mtfbtc', 'mtfbtcext', 'breadth', 'btcbreadth']) {
    const cr = coins.filter(c => c.recs[name]).map(c => ({ coin: c.coin, L: c.recs[name].L, S: c.recs[name].S }));
    if (cr.length) variants[name] = cr;
  }
  // wersje skalibrowane dla modeli z aplikacji
  for (const name of ['mtfbtc', 'btc', 'btcext', 'base']) if (variants[name] && (name === { '1h': 'mtfbtc', '4h': 'btc', '1d': 'btcext', '30d': 'btcext' }[IV])) variants[name + '+kalibracja'] = calibrate(variants[name], H);

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
