// Przegląd przegranych scenariuszy z historii aplikacji: czy po wybiciu stopu cena i tak doszła do celu?
// Dla każdej straty (24 godz., 3 dni, 14 dni): świece 1h od chwili stopu do końca horyzontu (oraz +1 horyzont dłużej).
// Do tego symulacja szerszego stopu (1,25×, 1,5×, 2×) na wszystkich rozliczonych scenariuszach, przy tym samym ryzyku w $ (wynik w R).
const fs = require('fs');
const X = require('../app/exchanges.js');
const H = JSON.parse(fs.readFileSync(process.argv[2] || 'history.json', 'utf8'));
const HMS = { '1h': 24, '4h': 72, '1d': 336 };
const done = H.filter(p => HMS[p.iv] && ['win', 'loss', 'expired'].includes(p.status) && p.price > 0 && p.stop > 0 && p.target > 0);
const t0 = Math.min(...done.map(p => p.t));
const need = Math.ceil((Date.now() - t0) / 36e5) + 60;
const fetchK = { binance: (s, n) => X.binanceKlines(s, '1h', n), bingx: (s, n) => X.bingxKlines(s, '1h', n), okx: (s, n) => X.okxKlines(s, '1h', n) };
(async () => {
  const K = new Map();
  for (const key of [...new Set(done.map(p => p.ex + '|' + p.sym))]) {
    const [ex, sym] = key.split('|');
    try { K.set(key, await fetchK[ex](sym, need)); } catch (e) { console.log('BRAK', key, e.message); }
  }
  const rows = [];
  for (const p of done) {
    const k = K.get(p.ex + '|' + p.sym); if (!k || !k.t.length) continue;
    const L = p.dir === 'LONG', sd = Math.abs(p.price - p.stop), td = Math.abs(p.target - p.price), hz = HMS[p.iv] * 36e5;
    const end = p.end || p.t + hz;
    const r = { p, L, sd, td };
    if (p.status === 'loss' && p.closedAt) {
      // po stopie: czy cena doszła do celu do końca horyzontu / do końca + 1 horyzont; jak głęboko zeszła za stop
      let hitIn = null, hitExt = null, deep = 0;
      for (let i = 0; i < k.t.length; i++) {
        if (k.t[i] + 36e5 <= p.closedAt) continue;
        if (k.t[i] > end + hz) break;
        const adv = L ? (p.stop - k.l[i]) / sd : (k.h[i] - p.stop) / sd;
        const hit = L ? k.h[i] >= p.target : k.l[i] <= p.target;
        if (hit) { if (k.t[i] < end && hitIn === null) hitIn = k.t[i]; if (hitExt === null) { hitExt = k.t[i]; break; } }
        if (adv > deep) deep = adv;
      }
      r.hitIn = hitIn; r.hitExt = hitExt; r.deep = deep;
    }
    // symulacja szerszego stopu od chwili wejścia (świece 1h; cel i stop w jednej świecy = stop)
    r.sim = {};
    for (const m of [1, 1.25, 1.5, 2]) {
      const st = L ? p.price - m * sd : p.price + m * sd; let res = null, last = p.price;
      for (let i = 0; i < k.t.length; i++) {
        if (k.t[i] + 36e5 <= p.t) continue; if (k.t[i] >= end) break;
        last = k.c[i];
        const hs = L ? k.l[i] <= st : k.h[i] >= st, ht = L ? k.h[i] >= p.target : k.l[i] <= p.target;
        if (hs) { res = -1; break; } if (ht) { res = td / (m * sd); break; }
      }
      if (res === null) res = (L ? last - p.price : p.price - last) / (m * sd);
      r.sim[m] = res - 0.2 / 100 * p.price / (m * sd); // koszty ok. 0,2% za wejście i wyjście
    }
    rows.push(r);
  }
  const pc = (a, b) => (b ? (a / b * 100).toFixed(0) + '%' : '–');
  for (const iv of ['1h', '4h', '1d']) {
    const ls = rows.filter(r => r.p.iv === iv && r.p.status === 'loss' && r.deep !== undefined);
    const inH = ls.filter(r => r.hitIn !== null), ext = ls.filter(r => r.hitExt !== null);
    const dIn = inH.map(r => r.deep).sort((a, b) => a - b), med = dIn.length ? dIn[Math.floor(dIn.length / 2)] : 0;
    console.log(`SR ${iv}: strat ${ls.length} · po stopie cel w horyzoncie: ${inH.length} (${pc(inH.length, ls.length)}) · cel do +1 horyzontu: ${ext.length} (${pc(ext.length, ls.length)}) · mediana zejścia za stop przed powrotem: ${med.toFixed(2)}× odl. stopu · zejście ≤0,25×: ${dIn.filter(x => x <= 0.25).length}, ≤0,5×: ${dIn.filter(x => x <= 0.5).length}, ≤1×: ${dIn.filter(x => x <= 1).length}`);
    const all = rows.filter(r => r.p.iv === iv);
    const line = [1, 1.25, 1.5, 2].map(m => { const s = all.reduce((q, r) => q + r.sim[m], 0); const w = all.filter(r => r.sim[m] > 0).length; return `stop ${m}×: śr. ${(s / all.length >= 0 ? '+' : '') + (s / all.length).toFixed(3)}R, na plus ${pc(w, all.length)}, suma ${s.toFixed(1)}R`; }).join(' | ');
    console.log(`SS ${iv}: ${all.length} scen. | ${line}`);
    for (const r of inH.slice(-12)) console.log(`SX ${iv} ${new Date(r.p.t).toISOString().slice(0, 16)} ${r.p.base} ${r.p.dir} wejście ${r.p.price} stop ${r.p.stop} cel ${r.p.target} · stop ${new Date(r.p.closedAt).toISOString().slice(5, 16)} → cel ${new Date(r.hitIn).toISOString().slice(5, 16)} · zejście za stop ${r.deep.toFixed(2)}×`);
  }
})();
