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
const PUMP = MODE === 'pumpfade';
const PULL = MODE === 'pullback' || MODE === 'pullbacklimit';
const FH = MODE === 'fh';               // fh: konta F (kopia aplikacji, cel 2:1) i H (to samo + ciągnięcie zysku) – portfel, ROI miesięczne
const EACCT = MODE === 'eacct';           // eacct: symulacja całego konta E (24 godz. najlepszy układ + trend dzienny), tylko IV=1h          // pullback: short na odbiciu do EMA20 w trendzie spadkowym przy słabnącym wolumenie (long lustrzanie)          // pumpfade: short na coinach po dużym wystrzale, które już spadają od szczytu            // trend: wybicie z kanału + ciągnięty stop (bez stałego celu)          // reversal: reguła „odwrócenie trendu” (bez modelu), jak planowane konto F          // exits: porównanie sposobów zamykania pozycji (cel / stop na wejście / ciągnięcie zysku)            // auto: model sam wybiera układ (2:1, 1:1, 1:2) dla każdego scenariusza
const LEV = LEVS[AUTO || EXITS || REV || TREND || PUMP || PULL || EACCT || FH ? 'big' : MODE]; // [cel, stop] w ATR
// model jak w aplikacji dla danego horyzontu
const PROD = { '1h': 'mtfbtc', '4h': 'btc', '1d': 'btc', '30d': 'base' }[IV];
const RW = LEV[0] / LEV[1];                 // ile R daje trafiony cel
const VALID_N = +(process.env.VALID_N || 1000), REFIT = 200, BE = LEV[1] / (LEV[0] + LEV[1]);

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
const PUMP_VARIANTS = {
  'późno: spadek ≥ 30% od szczytu': { X: 2, Y: 0.3, m: 2.5 },
  'późno + BTC w spadku': { X: 2, Y: 0.3, m: 2.5, btc: true },
  'wcześnie: spadek ≥ 15%, MA5 pod MA10': { X: 2, Y: 0.15, m: 3, early: true },
  'wcześnie + BTC w spadku': { X: 2, Y: 0.15, m: 3, early: true, btc: true },
  'bardzo wcześnie: spadek ≥ 10%, MA5 pod MA10, szczyt ≤ 10 świec temu': { X: 2, Y: 0.10, m: 3, early: true, fresh: 10 },
};
function pumpTrades(k, raw, H, P, W, btcAt) {
  const n = k.c.length, out = []; let busy = -1; const sma10 = new Array(n).fill(null), sma5 = new Array(n).fill(null);
  for (let i = 9; i < n; i++) { let a = 0; for (let j = i - 9; j <= i; j++) a += k.c[j]; sma10[i] = a / 10; let b = 0; for (let j = i - 4; j <= i; j++) b += k.c[j]; sma5[i] = b / 5; }
  for (let i = W + 20; i < n - 2; i++) {
    if (i <= busy) continue; const r = raw[i]; if (!r || !(r.atr > 0)) continue;
    let pk = -Infinity, pkI = -1; for (let j = i - W; j < i; j++) if (k.h[j] > pk) { pk = k.h[j]; pkI = j; }
    let lo = Infinity; for (let j = Math.max(0, pkI - W); j < pkI; j++) if (k.l[j] < lo) lo = k.l[j];
    const px = k.c[i];
    if (!(pk / lo >= P.X && px <= pk * (1 - P.Y) && px >= lo * 1.3)) continue;
    if (P.early) { if (!(sma5[i] < sma10[i] && px < sma5[i])) continue; } else if (!(r.slope < 0 && px < sma10[i] && r.trend < 0)) continue;
    if (P.fresh && i - pkI > P.fresh) continue;
    if (P.btc) { const bt = btcAt(k.t[i]); if (!(bt !== null && bt < 0)) continue; }
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
// Granie w kierunku trendu na odbiciach: trend spadkowy (cena ≥ 1 ATR pod EMA50, EMA20 spada), cena podeszła pod EMA20
// (szczyt świecy ≥ EMA20), ale zamknęła się pod nią; wolumen poniżej średniej (odbicie bez siły), RSI 40–60.
// SHORT, stop nad szczytem świecy + 0,5 ATR (min. 1,3%). Wyjście: cel 2R albo ciągnięty stop (warianty). Long lustrzanie.
const PULL_VARIANTS = MODE === 'pullbacklimit' ? {
  'wejście po rynku (jak teraz)': { exit: 'trail', m: 2 },
  'limit na EMA20, 1 dzień': { exit: 'trail', m: 2, entry: 'ema20', wait: 1 },
  'limit na EMA20, 3 dni': { exit: 'trail', m: 2, entry: 'ema20', wait: 3 },
  'limit cena ± 0,5 ATR, 2 dni': { exit: 'trail', m: 2, entry: 'atr', wait: 2 },
  'limit na SMA30, 3 dni': { exit: 'trail', m: 2, entry: 'sma30', wait: 3 },
} : { 'cel 2R': { exit: 'tp', tp: 2 }, 'cel 1,5R': { exit: 'tp', tp: 1.5 }, 'ciągnięty stop 2 ATR': { exit: 'trail', m: 2 } };
function pullTrades(k, raw, H, P) {
  const n = k.c.length, out = []; let busy = -1; const ema = new Array(n).fill(null); const a = 2 / 21; let e = k.c[0];
  for (let i = 0; i < n; i++) { e = i ? a * k.c[i] + (1 - a) * e : e; ema[i] = e; }
  const sma30 = new Array(n).fill(null); for (let i = 29; i < n; i++) { let q = 0; for (let j = i - 29; j <= i; j++) q += k.c[j]; sma30[i] = q / 30; }
  let signals = 0, filled = 0;
  for (let i = 60; i < n - 2; i++) {
    if (i <= busy) continue; const r = raw[i]; if (!r || !(r.atr > 0)) continue;
    let L = null;
    if (r.trend <= -1 && r.slope < 0 && k.h[i] >= ema[i] && k.c[i] < ema[i] && r.volRatio < 1 && r.rsi >= 40 && r.rsi <= 60) L = false;
    else if (r.trend >= 1 && r.slope > 0 && k.l[i] <= ema[i] && k.c[i] > ema[i] && r.volRatio < 1 && r.rsi >= 40 && r.rsi <= 60) L = true;
    if (L === null) continue;
    signals++;
    const atr = r.atr, d0 = Math.max(L ? k.c[i] - k.l[i] + 0.5 * atr : k.h[i] - k.c[i] + 0.5 * atr, k.c[i] * 0.013);
    const stop0 = L ? k.c[i] - d0 : k.c[i] + d0;
    let px = k.c[i], i0 = i, cost = 0.002;
    if (P.entry) {
      // zlecenie z limitem po lepszej cenie (short: wyżej, long: niżej), ważne P.wait dni; prowizja maker przy wejściu
      const lim0 = P.entry === 'ema20' ? ema[i] : P.entry === 'sma30' ? sma30[i] : (L ? k.c[i] - 0.5 * atr : k.c[i] + 0.5 * atr);
      const lim = L ? Math.min(lim0, k.c[i]) : Math.max(lim0, k.c[i]);
      if (!(L ? lim > stop0 * 1.002 : lim < stop0 * 0.998)) continue; // limit za stopem – bez sensu
      let fj = -1; for (let j = i + 1; j <= i + P.wait && j < n; j++) { if (L ? k.l[j] <= lim : k.h[j] >= lim) { fj = j; break; } if (L ? k.l[j] <= stop0 : k.h[j] >= stop0) break; }
      if (fj < 0) continue;
      px = lim; i0 = fj; cost = 0.0012; filled++;
      if (L ? k.l[fj] <= stop0 : k.h[fj] >= stop0) { out.push({ t: k.t[i], side: L ? 'L' : 'S', r: -1 - cost * px / Math.abs(px - stop0), bars: 0 }); busy = fj; continue; }
    }
    const d = Math.abs(px - stop0); if (d < px * 0.004) continue;
    let stop = stop0, best = px, j, exit = null; const tgt = P.exit === 'tp' ? (L ? px + P.tp * d : px - P.tp * d) : null;
    for (j = i0 + 1; j < n && j <= i0 + (P.exit === 'tp' ? H : 3 * H); j++) {
      const hs = L ? k.l[j] <= stop : k.h[j] >= stop;
      if (hs) { exit = L ? Math.min(stop, k.o[j]) : Math.max(stop, k.o[j]); break; }
      if (tgt !== null && (L ? k.h[j] >= tgt : k.l[j] <= tgt)) { exit = tgt; break; }
      if (P.exit === 'trail') { best = L ? Math.max(best, k.c[j]) : Math.min(best, k.c[j]); const ns = L ? best - P.m * atr : best + P.m * atr; if (L ? ns > stop : ns < stop) stop = ns; }
    }
    if (exit === null) { j = Math.min(j, n - 1); exit = k.c[j]; }
    out.push({ t: k.t[i], side: L ? 'L' : 'S', r: (L ? exit - px : px - exit) / d - cost * px / d, bars: j - i }); busy = j;
  }
  out.signals = signals; out.filled = filled;
  return out;
}
// pojedyncza transakcja na świecach 1h dla układu [cel, stop] w ATR; 2:1 z ciągnięciem zysku (jak D/E), max 2× czas
function tradeSim(k, i, atr, lev, long, H, trail) {
  const n = k.c.length, e = k.c[i], st = lev[1] * atr, tg = lev[0] * atr; let stop = long ? e - st : e + st;
  const target = long ? e + tg : e - tg; let best = e, j, R = null; const maxJ = Math.min(n - 1, i + (trail ? 2 * H : H));
  for (j = i + 1; j <= maxJ; j++) {
    if (long ? k.l[j] <= stop : k.h[j] >= stop) { R = ((long ? Math.min(stop, k.o[j]) - e : e - Math.max(stop, k.o[j]))) / st; break; }
    if (!trail && (long ? k.h[j] >= target : k.l[j] <= target)) { R = tg / st; break; }
    if (trail) { best = long ? Math.max(best, k.h[j]) : Math.min(best, k.l[j]); if (long ? best >= target : best <= target) { const ns = long ? best - st : best + st; if (long ? ns > stop : ns < stop) stop = ns; } }
  }
  if (R === null) { j = maxJ; R = (long ? k.c[j] - e : e - k.c[j]) / st; }
  return { R: R - 0.002 * e / st, bars: j - i, stopFrac: st / e };
}
// Wejście z potwierdzeniem: poziomy stopu i celu zostają jak w aplikacji (liczone od ceny sygnału), ale bot wchodzi
// dopiero gdy wykres potwierdzi kierunek; jeśli wcześniej cena dotknie stopu albo minie czas na potwierdzenie – brak wejścia.
// rule 'green': następna świeca 1h zamyka się w kierunku scenariusza (wejście na jej zamknięciu)
// rule 'break': cena wybija szczyt (dołek) świecy sygnału w ciągu 3 świec (wejście po cenie wybicia)
// rule 'hold2': 2 świece bez nowego dołka (szczytu) poniżej ceny sygnału, wejście na zamknięciu drugiej
function confirmSim(k, i, atr, lev, long, H, rule) {
  const n = k.c.length, e0 = k.c[i], st = lev[1] * atr, tg = lev[0] * atr;
  const stop = long ? e0 - st : e0 + st, target = long ? e0 + tg : e0 - tg;
  let j0 = null, e = null;
  if (rule === 'green') { const j = i + 1; if (j < n && (long ? k.l[j] > stop : k.h[j] < stop) && (long ? k.c[j] > k.o[j] && k.c[j] > e0 : k.c[j] < k.o[j] && k.c[j] < e0)) { j0 = j; e = k.c[j]; } }
  if (rule === 'break') { const lvl = long ? k.h[i] : k.l[i]; for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) { if (long ? k.l[j] <= stop : k.h[j] >= stop) break; if (long ? k.h[j] >= lvl : k.l[j] <= lvl) { j0 = j; e = long ? Math.max(lvl, k.o[j]) : Math.min(lvl, k.o[j]); break; } } }
  if (rule === 'hold2') { let ok = true; for (let j = i + 1; j <= i + 2; j++) { if (j >= n || (long ? k.l[j] < e0 - 0.3 * st : k.h[j] > e0 + 0.3 * st)) { ok = false; break; } } if (ok && i + 2 < n) { j0 = i + 2; e = k.c[i + 2]; } }
  if (j0 === null) return null;
  if (long ? (e >= target || e <= stop) : (e <= target || e >= stop)) return null;
  const risk = Math.abs(e - stop); let R = null, j; const maxJ = Math.min(n - 1, i + H);
  for (j = j0 + (rule === 'break' ? 0 : 1); j <= maxJ; j++) {
    if (long ? k.l[j] <= stop : k.h[j] >= stop) { R = -(Math.abs(e - (long ? Math.min(stop, j === j0 ? stop : k.o[j]) : Math.max(stop, j === j0 ? stop : k.o[j])))) / risk; break; }
    if (j > j0 && (long ? k.h[j] >= target : k.l[j] <= target)) { R = Math.abs(target - e) / risk; break; }
  }
  if (R === null) { j = maxJ; R = (long ? k.c[j] - e : e - k.c[j]) / risk; }
  return { R: R - 0.002 * e / risk, bars: j - i, stopFrac: risk / e };
}
// „Trader”: model podsuwa scenariusz, bot sam sprawdza checklistę przed wejściem (dla shorta lustrzanie):
// warunek konieczny – wybicie szczytu 2 ostatnich świec w ciągu 3 świec (zanim cena dotknie stopu);
// punkty: brak nowego dołka 24h w ostatnich 2 świecach (nie łapie noża), RSI 40–75 i rośnie, cena nad EMA20,
// wolumen ostatniej świecy ≥ średnia z 20, trend 4h (EMA20) nie przeciw. Wejście przy wybiciu, gdy punktów ≥ minScore.
function indArrays(k, k4) {
  const n = k.c.length, ema = new Array(n), rsi = new Array(n).fill(50), vav = new Array(n).fill(null);
  const a = 2 / 21; ema[0] = k.c[0]; for (let i = 1; i < n; i++) ema[i] = ema[i - 1] + a * (k.c[i] - ema[i - 1]);
  let g = 0, l = 0; for (let i = 1; i < n; i++) { const d = k.c[i] - k.c[i - 1], u = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= 14) { g += u / 14; l += dn / 14; } else { g = (g * 13 + u) / 14; l = (l * 13 + dn) / 14; } if (i >= 14) rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  let sv = 0; for (let i = 0; i < n; i++) { sv += k.v[i]; if (i >= 20) sv -= k.v[i - 20]; if (i >= 19) vav[i] = sv / 20; }
  let t4 = null;
  if (k4 && k4.c.length > 30) { const e4 = [k4.c[0]]; for (let i = 1; i < k4.c.length; i++) e4.push(e4[i - 1] + a * (k4.c[i] - e4[i - 1]));
    let j = 0; t4 = k.t.map(tt => { while (j + 1 < k4.t.length && k4.t[j + 1] + 4 * 36e5 <= tt + 36e5) j++; return j >= 3 && k4.t[j] + 4 * 36e5 <= tt + 36e5 ? e4[j] - e4[j - 3] : null; }); }
  return { ema, rsi, vav, t4 };
}
function traderSim(k, i, atr, lev, long, H, A, minScore, entryMode = 'now', waitBars = 6, trail = null) {
  const n = k.c.length, e0 = k.c[i], st = lev[1] * atr, tg = lev[0] * atr;
  const stop = long ? e0 - st : e0 + st, target = long ? e0 + tg : e0 - tg;
  if (i < 30) return null;
  const lvl = long ? Math.max(k.h[i], k.h[i - 1]) : Math.min(k.l[i], k.l[i - 1]);
  for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) {
    if (long ? k.l[j] <= stop && !(k.h[j] >= lvl && k.o[j] > stop) : k.h[j] >= stop && !(k.l[j] <= lvl && k.o[j] < stop)) return null;
    if (!(long ? k.h[j] >= lvl : k.l[j] <= lvl)) continue;
    const q = j - 1; let sc = 0;
    const recent = long ? Math.min(k.l[q], k.l[q - 1]) : Math.max(k.h[q], k.h[q - 1]); let ext = recent;
    for (let m = q - 23; m <= q - 2; m++) ext = long ? Math.min(ext, k.l[m]) : Math.max(ext, k.h[m]);
    if (long ? recent > ext : recent < ext) sc++;
    if (long ? (A.rsi[q] >= 40 && A.rsi[q] <= 75 && A.rsi[q] > A.rsi[q - 2]) : (A.rsi[q] <= 60 && A.rsi[q] >= 25 && A.rsi[q] < A.rsi[q - 2])) sc++;
    if (long ? k.c[q] > A.ema[q] : k.c[q] < A.ema[q]) sc++;
    if (A.vav[q] && k.v[q] >= A.vav[q]) sc++;
    if (A.t4 && A.t4[q] !== null && (long ? A.t4[q] >= 0 : A.t4[q] <= 0)) sc++;
    if (sc < minScore) return null;
    let e = long ? Math.max(lvl, k.o[j]) : Math.min(lvl, k.o[j]); let jStart = j;
    if (entryMode !== 'now') {
      // po potwierdzeniu: zlecenie z limitem na korektę, ważne waitBars świec; cel przed wejściem = okazja przepada, stop przed wejściem = brak wejścia
      const lim = entryMode === 'lvl' ? lvl : entryMode === 'sig' ? e0 : (lvl + e0) / 2;
      let f = null;
      for (let m = j; m <= Math.min(n - 1, j + waitBars); m++) {
        if (m > j && (long ? k.l[m] <= stop : k.h[m] >= stop)) break;
        if (m === j ? false : (long ? k.l[m] <= lim : k.h[m] >= lim)) { f = m; break; }
        if (long ? k.h[m] >= target : k.l[m] <= target) break;
      }
      if (f === null) return null;
      e = long ? Math.min(lim, k.o[f]) : Math.max(lim, k.o[f]); jStart = f;
    }
    if (long ? (e >= target || e <= stop) : (e <= target || e >= stop)) return null;
    const risk = Math.abs(e - stop); let R = null, jj; const maxJ = Math.min(n - 1, i + (trail ? 2 * H : H));
    let st2 = stop, best = e, on = false;
    for (jj = jStart; jj <= maxJ; jj++) {
      if (long ? k.l[jj] <= st2 : k.h[jj] >= st2) { R = on ? ((long ? Math.min(st2, k.o[jj]) - e : e - Math.max(st2, k.o[jj])) / risk) : -1; break; }
      if (jj > jStart && (long ? k.h[jj] >= target : k.l[jj] <= target)) {
        if (!trail) { R = Math.abs(target - e) / risk; break; }
        on = true;
      }
      if (on) { best = long ? Math.max(best, k.h[jj]) : Math.min(best, k.l[jj]); const tgD = Math.abs(target - e);
        // 'r1': stop 1R za najlepszą ceną; 'half': co najmniej połowa drogi do celu zabezpieczona, potem 1R za najlepszą
        const ns = trail === 'r1' ? (long ? best - risk : best + risk) : (long ? Math.max(e + tgD * 0.5, best - risk) : Math.min(e - tgD * 0.5, best + risk));
        if (long ? ns > st2 : ns < st2) st2 = ns; }
    }
    if (R === null) { jj = maxJ; R = (long ? k.c[jj] - e : e - k.c[jj]) / risk; }
    return { R: R - 0.002 * e / risk, bars: jj - i, sc };
  }
  return null;
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
      if (FH) {
        const f = features(k, btcCtx, k4); const raw = f.raw, n = k.c.length; const cand = [];
        run(PROD, f.Z, raw, 0.3, LEV); const IA = indArrays(k, k4);
        for (const side of ['L', 'S']) for (const r of recs[PROD][side]) {
          const rw = raw[r.i]; if (!rw || !(rw.atr > 0)) continue;
          const a = tradeSim(k, r.i, rw.atr * SCALE, LEV, side === 'L', H, false), b = tradeSim(k, r.i, rw.atr * SCALE, LEV, side === 'L', H, true);
          const cf = {}; for (const rule of ['break']) { const c = confirmSim(k, r.i, rw.atr * SCALE, LEV, side === 'L', H, rule); cf[rule] = c ? [c.R, k.t[Math.min(r.i + c.bars, n - 1)] + STEP] : null; }
          for (const [nm, em, tr] of [['tr2', 'now', null], ['tTr1', 'now', 'r1'], ['tHalf', 'now', 'half']]) { const c = traderSim(k, r.i, rw.atr * SCALE, LEV, side === 'L', H, IA, 2, em, 6, tr); cf[nm] = c ? [c.R, k.t[Math.min(r.i + c.bars, n - 1)] + STEP] : null; }
          cand.push({ side, t: k.t[r.i] + STEP, p: r.p, prior: r.prior, rskill: r.rskill, sf: a.stopFrac, RF: a.R, RH: b.R, eF: k.t[Math.min(r.i + a.bars, n - 1)] + STEP, eH: k.t[Math.min(r.i + b.bars, n - 1)] + STEP, cf });
        }
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs: { fh: cand }, pool: null }); continue;
      }
      if (EACCT) {
        const f = features(k, btcCtx, k4); const raw = f.raw, n = k.c.length; const cand = [];
        for (const ly of ['big', 'equal', 'safe']) {
          run(PROD + '|' + ly, f.Z, raw, 0.3, LEVS[ly]);
          for (const side of ['L', 'S']) for (const r of recs[PROD + '|' + ly][side]) {
            const rw = raw[r.i]; if (!rw || !(rw.atr > 0)) continue;
            const tr = tradeSim(k, r.i, rw.atr * SCALE, LEVS[ly], side === 'L', H, ly === 'big');
            cand.push({ type: '24h', ly, side, t: k.t[r.i] + 36e5, p: r.p, prior: r.prior, rskill: r.rskill, R: tr.R, stopFrac: tr.stopFrac, tEnd: k.t[Math.min(r.i + tr.bars, n - 1)] + 36e5 });
          }
          delete recs[PROD + '|' + ly];
        }
        try {
          const kd = await X.getKlines(t.ex, t.sym, '1d', E.HISTORY);
          if (kd && kd.c.length > 120) {
            const fd = features(kd);
            for (const x of trendTrades(kd, fd.raw, 14, { N: 55, m: 3 })) cand.push({ type: 'wybicie', side: x.side, t: x.t + 864e5, tEnd: x.t + (x.bars + 1) * 864e5, R: x.r });
            for (const x of pullTrades(kd, fd.raw, 14, { exit: 'trail', m: 2 })) cand.push({ type: 'odbicie', side: x.side, t: x.t + 864e5, tEnd: x.t + (x.bars + 1) * 864e5, R: x.r });
          }
        } catch (e) { }
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs: { e: cand }, pool: null }); continue;
      }
      if (PULL) {
        const f = features(k); const trades = [];
        for (const [vn, P] of Object.entries(PULL_VARIANTS)) for (const x of pullTrades(k, f.raw, H, P)) trades.push({ ...x, v: vn });
        parentPort.postMessage({ coin: t.ex + ':' + t.base, recs: { rev: trades }, pool: null }); continue;
      }
      if (PUMP) {
        const f = features(k); const trades = []; const W = BARS === '1d' ? 60 : IV === '4h' ? 180 : 360;
        let jb = 0; const btcAt = tt => { while (jb + 1 < btcCtx.t.length && btcCtx.t[jb + 1] <= tt) jb++; if (btcCtx.t[jb] > tt) jb = 0; return btcCtx.t[jb] <= tt ? btcCtx.v[jb][0] : null; };
        for (const [vn, P] of Object.entries(PUMP_VARIANTS)) { jb = 0; for (const x of pumpTrades(k, f.raw, H, P, W, btcAt)) trades.push({ ...x, v: vn }); }
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
  if (FH) {
    const liftMin = +(process.env.FH_LIFT || 0.08), MINSTOP = (E.MIN_STOP_PCT || 1.3) / 100, TOPN = +(process.env.FH_TOP || 10);
    const byT = new Map();
    for (const c of coins) for (const x of c.recs.fh || []) {
      const lift = x.p - x.prior;
      if (!(x.rskill !== null && x.rskill >= 0.01 && x.p > BE + 0.02 && lift >= liftMin && x.sf >= MINSTOP)) continue;
      if (!byT.has(x.t)) byT.set(x.t, new Map()); const m = byT.get(x.t), prev = m.get(c.coin);
      if (!prev || lift > prev.lift) m.set(c.coin, { ...x, lift, coin: c.coin });
    }
    const picks = []; const blocked = new Map();
    for (const t of [...byT.keys()].sort((a, b) => a - b)) { let n = 0;
      for (const x of [...byT.get(t).values()].sort((a, b) => b.lift - a.lift)) { if (n >= TOPN) break; const key = x.coin + x.side; if ((blocked.get(key) || 0) > t) continue; blocked.set(key, t + H * STEP); n++; picks.push(x); } }
    const fhSim = (P, which, from, to) => {
      const ev = P.filter(x => x.t >= from && x.t <= to).sort((a, b) => a.t - b.t);
      let bal = 1000, open = [], day = '', dayStart = bal, halted = false, peak = bal, dd = 0; const trades = [], curve = [[from, bal]];
      const closeUntil = t => { open.sort((a, b) => a.end - b.end); while (open.length && open[0].end <= t) { const o = open.shift(); bal += o.risk * o.R; trades.push(o); curve.push([o.end, bal]); peak = Math.max(peak, bal); dd = Math.max(dd, (peak - bal) / peak); } };
      for (const x of ev) {
        closeUntil(x.t);
        const d = new Date(x.t + 36e5).toISOString().slice(0, 10); if (d !== day) { day = d; dayStart = bal; halted = false; }
        if (!halted && (dayStart - bal) / dayStart >= 0.06) halted = true;
        if (halted || open.length >= 10 || open.some(o => o.coin === x.coin)) continue;
        if (open.reduce((a, o) => a + o.risk, 0) + bal * 0.01 > bal * 0.10) continue;
        let R, end;
        if (which === 'F') { R = x.RF; end = x.eF; } else if (which === 'H') { R = x.RH; end = x.eH; }
        else { const c = x.cf && x.cf[which]; if (!c) continue; R = c[0]; end = c[1]; }
        open.push({ coin: x.coin, side: x.side, R, end, risk: bal * 0.01, t: x.t });
      }
      closeUntil(Infinity);
      const months = (to - from) / (30 * 864e5), mret = [];
      for (let m0 = from; m0 + 30 * 864e5 <= to + 864e5; m0 += 30 * 864e5) {
        const at = tt => { let v = 1000; for (const [ct, b] of curve) { if (ct <= tt) v = b; else break; } return v; };
        mret.push((at(m0 + 30 * 864e5) / at(m0) - 1) * 100);
      }
      const w = trades.filter(o => o.R > 0).length, avR = trades.reduce((a, o) => a + o.R, 0) / (trades.length || 1);
      const geo = (Math.pow(bal / 1000, 1 / months) - 1) * 100;
      return { n: trades.length, win: w / (trades.length || 1), avR, bal, geo, dd: dd * 100, months, mret };
    };
    const from = Math.min(...picks.map(x => x.t)), to = Math.max(...picks.map(x => x.t));
    console.log(`\n=== pula: przewaga ≥ ${liftMin}, TOP ${TOPN} · F (kopia aplikacji 2:1) vs H (kopia + ciągnięcie zysku) · horyzont ${IV} · ${coins.length} coinów · ${picks.length} zielonych scenariuszy ===`);
    console.log(`Okres: ${new Date(from).toISOString().slice(0, 10)} – ${new Date(to).toISOString().slice(0, 10)} · start 1000 $, ryzyko 1% na pozycję (procent składany), maks. 10 pozycji, 1 na coin, łączne ryzyko ≤10%, dzienny limit straty 6%, koszty 0,1%/stronę`);
    for (const [lbl, a, b] of [['cały test', from, to], ['1. połowa', from, (from + to) / 2], ['2. połowa', (from + to) / 2, to], ['ostatnie 30 dni', to - 30 * 864e5, to]]) {
      for (const w of ['F', 'H', 'tr2', 'tTr1', 'tHalf']) { const r = fhSim(picks, w, a, b);
        console.log(`${lbl.padEnd(16)} ${({ F: 'F bez potw.', H: 'H ciągnięcie', break: 'samo wybicie', tr2: 'I: wejście przy wybiciu', tTr1: 'I + ciągnięcie (1R za ceną)', tHalf: 'I + ciągnięcie (½ celu pewne)' })[w].padEnd(26)}: ${String(r.n).padStart(4)} tr. · na plus ${(r.win * 100).toFixed(0)}% · śr. ${r.avR >= 0 ? '+' : ''}${r.avR.toFixed(2)}R · saldo ${r.bal.toFixed(0)} $ · ${r.geo >= 0 ? '+' : ''}${r.geo.toFixed(1)}% / mies. · maks. spadek ${r.dd.toFixed(1)}%${r.mret.length > 1 ? ' · miesiące: ' + r.mret.map(v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%').join(' ') : ''}`); }
    }
    const zlib = require('zlib');
    console.log('FHDATA:' + zlib.gzipSync(JSON.stringify(picks.map(x => [x.coin, x.side, x.t, +x.RF.toFixed(3), +x.RH.toFixed(3), x.eF, x.eH, +x.lift.toFixed(3)]))).toString('base64'));
    console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`); return;
  }
  if (EACCT) {
    const RW = { big: 2, equal: 1, safe: 0.5 }, BEL = { big: 1 / 3, equal: 0.5, safe: 2 / 3 };
    const ev = x => { const c = 0.002 / x.stopFrac; return x.p * (RW[x.ly] - c) - (1 - x.p) * (1 + c); };
    const model = [], daily = [];
    for (const c of coins) {
      const best = new Map();
      for (const x of c.recs.e || []) {
        if (x.type !== '24h') { daily.push({ ...x, coin: c.coin }); continue; }
        if (!(x.rskill !== null && x.rskill >= 0.01 && x.p > BEL[x.ly] + 0.02 && x.p - x.prior >= 0.08 && x.stopFrac >= 0.013)) continue;
        const e = ev(x); if (e < 0.15) continue;
        const k = x.t + x.side, o = best.get(k);
        if (!o || e > o.e + 0.03 || (Math.abs(e - o.e) <= 0.03 && x.p > o.p)) best.set(k, { ...x, e, coin: c.coin });
      }
      model.push(...best.values());
    }
    const sim = (events, from, to, maxOpen, risk) => {
      const ev2 = events.filter(x => x.t >= from && x.t <= to).sort((a, b) => a.t - b.t || (b.e || 0) - (a.e || 0));
      let open = [], closed = []; const take = [];
      for (const x of ev2) {
        open = open.filter(o => { if (o.tEnd <= x.t) { closed.push(o); return false; } return true; });
        if (open.length >= maxOpen || open.some(o => o.coin === x.coin)) continue;
        open.push(x); take.push(x);
      }
      closed.push(...open); closed.sort((a, b) => a.tEnd - b.tEnd);
      let eq = 0, peak = 0, dd = 0; for (const x of closed) { eq += x.R * risk; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
      const months = (to - from) / (30 * 864e5);
      return { take, months, perMonth: eq / months, dd };
    };
    const show = (lbl, r) => {
      console.log(`\n--- ${lbl}: ${r.months.toFixed(1)} mies., ${r.take.length} transakcji → ${r.perMonth >= 0 ? '+' : ''}${r.perMonth.toFixed(1)}% mies. (bez procentu składanego), najgłębszy spadek ${r.dd.toFixed(1)}%`);
      for (const tp of ['24h', 'wybicie', 'odbicie']) { const P = r.take.filter(x => x.type === tp); if (!P.length) continue;
        const w = P.filter(x => x.R > 0).length, av = P.reduce((a, x) => a + x.R, 0) / P.length;
        console.log(`   ${tp.padEnd(8)} ${String(P.length).padStart(4)} tr. · na plus ${(w / P.length * 100).toFixed(0)}% · średnio ${av >= 0 ? '+' : ''}${av.toFixed(2)}R${tp === '24h' ? ' · układy 2:1/1:1/1:2: ' + ['big', 'equal', 'safe'].map(l => P.filter(x => x.ly === l).length).join('/') : ''}`); }
    };
    const mFrom = Math.min(...model.map(x => x.t)), mTo = Math.max(...model.map(x => x.t), mFrom);
    console.log(`\n=== Konto E – symulacja całości (ryzyko 0,5% na pozycję, maks. 6 pozycji, 1 na coin, po kosztach) ===`);
    show(`okres testu modelu 24 godz. (${new Date(mFrom).toISOString().slice(0, 10)} – ${new Date(mTo).toISOString().slice(0, 10)}): wszystkie trzy części`, sim([...model, ...daily], mFrom, mTo, 6, 0.5));
    show('ten sam okres: tylko 24 godz.', sim(model, mFrom, mTo, 6, 0.5));
    const dFrom = Math.min(...daily.map(x => x.t)), dTo = Math.max(...daily.map(x => x.t));
    show(`tylko trend dzienny, cała historia (${new Date(dFrom).toISOString().slice(0, 10)} – ${new Date(dTo).toISOString().slice(0, 10)})`, sim(daily, dFrom, dTo, 6, 0.5));
    const half = (dFrom + dTo) / 2;
    show('trend dzienny – 1. połowa', sim(daily, dFrom, half, 6, 0.5));
    show('trend dzienny – 2. połowa', sim(daily, half, dTo, 6, 0.5));
    console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`); return;
  }
  if (REV || TREND || PUMP || PULL) {
    const VARS = PULL ? PULL_VARIANTS : PUMP ? PUMP_VARIANTS : TREND ? TREND_VARIANTS : REV_VARIANTS;
    const ALL = coins.flatMap(c => (c.recs.rev || []).map(x => ({ ...x, coin: c.coin }))).sort((a, b) => a.t - b.t);
    for (const vn of Object.keys(VARS)) { const all = ALL.filter(x => x.v === vn);
    const tEnd = all.length ? all[all.length - 1].t : 0;
    const row = (lbl, P) => { const w = P.filter(x => x.r > 0).length, av = P.reduce((a, x) => a + x.r, 0) / (P.length || 1);
      console.log(`${lbl.padEnd(34)} ${String(P.length).padStart(5)} transakcji · na plus ${(w / (P.length || 1) * 100).toFixed(0)}% · średnio ${av >= 0 ? '+' : ''}${av.toFixed(2)}R po kosztach`); };
    const days = all.length ? (tEnd - all[0].t) / 864e5 : 0;
    console.log(`\n=== ${PULL ? 'W trendzie na odbiciu' : PUMP ? 'Short po wystrzale' : TREND ? 'Z trendem' : 'Odwrócenie trendu'} – wersja ${vn} · ${coins.length} coinów · ok. ${days.toFixed(0)} dni ===`);
    row('wszystkie', all); row('LONG', all.filter(x => x.side === 'L')); row('SHORT', all.filter(x => x.side === 'S'));
    const h = all.length >> 1; row('1. połowa okresu', all.slice(0, h)); row('2. połowa okresu', all.slice(h));
    row('ostatnie 3 tygodnie', all.filter(x => x.t >= tEnd - 21 * 864e5));
    if (TREND || PUMP || PULL) { const R = all.map(x => x.r).sort((a, b) => a - b); console.log(`największa wygrana ${R.length ? R[R.length - 1].toFixed(1) : 0}R · średni czas ${(all.reduce((a, x) => a + x.bars, 0) / (all.length || 1)).toFixed(0)} świec · suma ${R.reduce((a, b) => a + b, 0).toFixed(0)}R`); }
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
