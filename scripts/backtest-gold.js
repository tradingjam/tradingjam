// Test na historii: scalping złota (PAXG/USDT, token oparty na złocie) na świecach 1m i 5m.
// Ten sam model co w aplikacji (regresja logistyczna, walk-forward, normalizacja tylko z przeszłości).
// Jedna pozycja naraz, wejście po zamknięciu świecy sygnału, stop 1×ATR, cel 2×ATR (albo 1×ATR dla 1:1),
// w jednej świecy cel i stop → stop. Wynik w R po kosztach dla kilku poziomów kosztów.
// Uruchom: SYM=PAXGUSDT node scripts/backtest-gold.js
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');
const I = E._internal;

const SYM = process.env.SYM || 'PAXGUSDT';
// GOLD_MODE=swing → dłuższe interwały (jak horyzonty aplikacji: 24 godz., 3 dni, 14 dni)
const SWING = process.env.GOLD_MODE === 'swing';
const CASES = SWING ? [
  { iv: '1h', n: 9000, H: 24, valid: 4000, label: '1h (horyzont 24 godz.)' },
  { iv: '4h', n: 6000, H: 18, valid: 3000, label: '4h (horyzont 3 dni)' },
  { iv: '1d', n: 2500, H: 14, valid: 1000, label: '1d (horyzont 14 dni)' },
] : [
  { iv: '1m', n: 30000, H: 30, valid: 10000, label: '1 min (horyzont 30 min)' },
  { iv: '5m', n: 20000, H: 24, valid: 10000, label: '5 min (horyzont 2 godz.)' },
];
const LAYOUTS = SWING
  ? [{ name: '2:1 (stop 1 ATR)', tg: 2, st: 1 }, { name: '2:1 (stop 2 ATR)', tg: 4, st: 2 }, { name: '1:1 (stop 1 ATR)', tg: 1, st: 1 }]
  : [{ name: '2:1', tg: 2, st: 1 }, { name: '1:1', tg: 1, st: 1 }];
const COSTS = [{ name: 'rynkowe 0,2%', c: 0.002 }, { name: 'limit ~0,08%', c: 0.0008 }, { name: 'bez kosztów', c: 0 }];
const REFIT_FRAC = 10, TRAIN_MAX = 15000;

function labels(k, raw, H, tg, st, long) {
  const n = k.c.length, Y = new Array(n).fill(null);
  for (let i = 0; i < n - H; i++) {
    const r = raw[i]; if (!r || !(r.atr > 0)) continue;
    const e = k.c[i], up = long ? e + tg * r.atr : e + st * r.atr, dn = long ? e - st * r.atr : e - tg * r.atr;
    let y = 0;
    for (let j = i + 1; j <= i + H; j++) {
      const hu = k.h[j] >= up, hd = k.l[j] <= dn;
      if (hu && hd) { y = -1; break; }            // obie w jednej świecy → stop
      if (long ? hu : hd) { y = 1; break; }
      if (long ? hd : hu) { y = -1; break; }
    }
    Y[i] = y;
  }
  return Y;
}

// wynik w R (bez kosztów) i indeks świecy wyjścia
function trade(k, i, atr, H, tg, st, long) {
  const e = k.c[i], up = long ? e + tg * atr : e + st * atr, dn = long ? e - st * atr : e - tg * atr;
  for (let j = i + 1; j <= i + H && j < k.c.length; j++) {
    const hu = k.h[j] >= up, hd = k.l[j] <= dn;
    if (hu && hd) return { r: -1, j };
    if (long ? hu : hd) return { r: tg / st, j };
    if (long ? hd : hu) return { r: -1, j };
  }
  const j = Math.min(i + H, k.c.length - 1);
  return { r: (long ? k.c[j] - e : e - k.c[j]) / (st * atr), j };
}

async function main() {
  console.log(`Scalping złota – ${SYM} · ${new Date().toISOString().slice(0, 16)}`);
  for (const cs of CASES) {
    const k = await X.binanceKlines(SYM, cs.iv, cs.n);
    const days = (k.t[k.t.length - 1] - k.t[0]) / 864e5;
    const { F, raw } = I.buildFeatures(k);
    const fz = I.foldZ(F);
    const n = k.c.length, atrPct = [];
    for (let i = n - cs.valid; i < n; i++) if (raw[i]) atrPct.push(raw[i].atr / k.c[i]);
    atrPct.sort((a, b) => a - b);
    console.log(`\n=== ${cs.label}: ${n} świec (${days.toFixed(0)} dni), mediana ATR ${(atrPct[atrPct.length >> 1] * 100).toFixed(3)}% ceny ===`);
    for (const L of LAYOUTS) {
      const BE = L.st / (L.tg + L.st);
      // predykcje walk-forward dla LONG i SHORT
      const preds = new Map();
      for (const long of [true, false]) {
        const Y = labels(k, raw, cs.H, L.tg, L.st, long); // 1 cel, −1 stop, 0 nic (jak w aplikacji)
        const lab = []; for (let i = 0; i < n - cs.H; i++) if (F[i] && Y[i] !== null) lab.push(i);
        const vs = lab.filter(i => i >= n - cs.valid - cs.H); const REFIT = Math.max(50, Math.round(cs.valid / REFIT_FRAC));
        let model = null, fitted = -Infinity, Zc = null;
        for (const t of vs) {
          if (t - fitted >= REFIT) {
            Zc = fz(t);
            const train = lab.filter(i => i <= t - cs.H).slice(-TRAIN_MAX);
            model = I.fitModel(Zc, Y, train, model && model.W); fitted = t;
          }
          const p = I.predictP(model, Zc[t]);
          if (!preds.has(t)) preds.set(t, {});
          preds.get(t)[long ? 'L' : 'S'] = { p: p[0], prior: model.prior[0] };
        }
      }
      for (const lift of [0.05, 0.08]) {
        // jedna pozycja naraz, wybór silniejszego kierunku
        const trades = []; let busyUntil = -1;
        for (const [t, pr] of [...preds.entries()].sort((a, b) => a[0] - b[0])) {
          if (t <= busyUntil || !raw[t]) continue;
          const c = ['L', 'S'].filter(d => pr[d] && pr[d].p > BE + 0.02 && pr[d].p - pr[d].prior >= lift).sort((a, b) => (pr[b].p - pr[b].prior) - (pr[a].p - pr[a].prior))[0];
          if (!c) continue;
          const tr = trade(k, t, raw[t].atr, cs.H, L.tg, L.st, c === 'L');
          trades.push({ ...tr, stopFrac: L.st * raw[t].atr / k.c[t] }); busyUntil = tr.j;
        }
        const vDays = (k.t[n - 1] - k.t[n - cs.valid]) / 864e5;
        const sf = trades.map(x => x.stopFrac).sort((a, b) => a - b);
        const half = trades.length >> 1, avg = a => a.reduce((x, y) => x + y.r - 0.002 / y.stopFrac, 0) / (a.length || 1);
        const extra = trades.length ? ` · stop mediana ${(sf[sf.length >> 1] * 100).toFixed(2)}% · połowy (koszty 0,2%): ${avg(trades.slice(0, half)).toFixed(2)} / ${avg(trades.slice(half)).toFixed(2)}R` : '';
        const line = COSTS.map(cc => {
          const R = trades.map(x => x.r - cc.c / x.stopFrac);
          const w = R.filter(v => v > 0).length, av = R.reduce((a, b) => a + b, 0) / (R.length || 1);
          const perMonth = R.reduce((a, b) => a + b, 0) / vDays * 30; // % mies. przy 1% ryzyka, bez procentu składanego
          return `${cc.name}: ${(w / (R.length || 1) * 100).toFixed(0)}% · ${av >= 0 ? '+' : ''}${av.toFixed(2)}R · ${perMonth >= 0 ? '+' : ''}${perMonth.toFixed(0)}% mies.`;
        }).join(' | ');
        console.log(`${L.name} · przewaga ≥ ${lift * 100} pkt · ${trades.length} transakcji (${(trades.length / vDays).toFixed(2)}/dzień) → ${line}${extra}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
