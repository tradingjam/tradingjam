// Bot „na sucho” (paper trading) – trzy WIRTUALNE konta po 1000 USDT, prawdziwe ceny BingX.
// Co godzinę, po skanie: zamyka pozycje (cel / stop / koniec czasu) i otwiera nowe.
// Konta różnią się tylko sposobem wyboru scenariuszy – żeby na żywo sprawdzić, co najlepiej mnoży kapitał:
//   A „Duży zysk 2:1”     – zielone scenariusze TOP 10 w układzie 2:1
//   B „Częste trafienia 1:1” – zielone scenariusze 1:1, tylko gdy model daje ≥ 55%
//   C „Złoty środek”      – dla każdego coina bot sam wybiera układ (2:1 albo 1:1) o wyższej oczekiwanej wartości
// Wszystkie liczą opłaty i poślizg. Ryzyko liczone od bieżącego salda, więc zyski same się „procentują”.
const fs = require('fs');
const path = require('path');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');

const BASE = {
  startBalance: 1000, riskPct: 0.01, maxOpen: 5, maxLeverage: 3,
  feePct: 0.0005, slipPct: 0.0005, dailyLossPct: 0.03, horizons: ['1h', '4h'], minQv: 3e5,
};
const ACCOUNTS = {
  A: { name: 'Duży zysk 2:1', desc: 'Zielone scenariusze TOP 10 w układzie 2:1 (cel 2× dalej niż stop).' },
  B: { name: 'Częste trafienia 1:1', desc: 'Zielone scenariusze w układzie 1:1, tylko gdy model daje co najmniej 55%.' },
  C: { name: 'Złoty środek', desc: 'Dla każdego coina bot sam wybiera układ 2:1 albo 1:1 – ten o wyższej oczekiwanej wartości.' },
};
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'out');
const H_MS = { '1h': 24 * 36e5, '4h': 72 * 36e5 };

async function loadState() {
  try {
    if (process.env.BOT_IN) return fs.existsSync(process.env.BOT_IN) ? JSON.parse(fs.readFileSync(process.env.BOT_IN, 'utf8')) : null;
    if (process.env.GITHUB_REPOSITORY) {
      const r = await fetch(`https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/data/bot.json?t=${Date.now()}`);
      if (r.ok) return await r.json();
    }
  } catch (e) { }
  return null;
}
const fresh = now => ({ startedAt: now, balance: BASE.startBalance, positions: [], closed: [], equity: [], day: null, log: [] });

const fill = (px, side, opening) => px * ((side === 'LONG') === opening ? 1 + BASE.slipPct : 1 - BASE.slipPct);
const pnl = (p, px) => (p.side === 'LONG' ? px - p.entry : p.entry - px) * p.qty;
const stamp = t => new Date(t).toISOString().slice(0, 16);

// ---------- kandydaci dla każdego konta ----------
// zwraca [{ coin, iv, side, p, mode, movePct, stopPct, ev, lift }]
function candidates(key, res) {
  const out = [];
  for (const iv of BASE.horizons) {
    const big = E.rankTop(res.coins, iv, 'all', 15, 'big').filter(r => r.tier === 0);
    const eq = E.rankTop(res.coins, iv, 'all', 15, 'equal').filter(r => r.tier === 0 && r.d.p >= 0.55);
    const mk = (r, mode) => ({
      coin: r.coin, iv, side: r.d.dir, p: r.d.p, mode, lift: r.lift, movePct: Math.abs(r.d.movePct), stopPct: Math.abs(r.d.stopPct),
      // oczekiwana wartość w R: 2:1 → 2p − (1−p); 1:1 → p − (1−p)
      ev: mode === 'big' ? 3 * r.d.p - 1 : 2 * r.d.p - 1,
    });
    if (key === 'A') big.forEach(r => out.push(mk(r, 'big')));
    if (key === 'B') eq.forEach(r => out.push(mk(r, 'equal')));
    if (key === 'C') {
      const m = new Map();
      for (const c of [...big.map(r => mk(r, 'big')), ...eq.map(r => mk(r, 'equal'))]) {
        const k = c.coin.base + iv; if (!m.has(k) || c.ev > m.get(k).ev) m.set(k, c);
      }
      for (const c of m.values()) if (c.ev >= 0.1) out.push(c);
    }
  }
  return out.sort((a, b) => (key === 'C' ? b.ev - a.ev : b.lift - a.lift));
}

async function runAccount(key, st, res, byBase, klinesFor, now) {
  // 1. zamykanie
  for (const p of [...st.positions]) {
    const k = await klinesFor(p.sym);
    let done = null;
    if (k) {
      for (let i = 0; i < k.t.length && !done; i++) {
        if (k.t[i] < p.openedAt || k.t[i] < (p.checkedTo || 0)) continue;
        if (k.t[i] >= p.end) break;
        const hitS = p.side === 'LONG' ? k.l[i] <= p.stop : k.h[i] >= p.stop;
        const hitT = p.side === 'LONG' ? k.h[i] >= p.target : k.l[i] <= p.target;
        if (hitS) done = [p.stop, 'stop', k.t[i] + 36e5];
        else if (hitT) done = [p.target, 'cel', k.t[i] + 36e5];
      }
      if (!done && k.t.length) p.checkedTo = k.t[k.t.length - 1];
    }
    const live = byBase.get(E.cleanBase(p.base));
    if (!done && live) {
      if (p.side === 'LONG' ? live.price <= p.stop : live.price >= p.stop) done = [p.stop, 'stop', now];
      else if (p.side === 'LONG' ? live.price >= p.target : live.price <= p.target) done = [p.target, 'cel', now];
    }
    if (!done && now >= p.end) done = [live ? live.price : p.entry, 'czas minął', now];
    if (done) {
      const exit = fill(done[0], p.side, false), fees = (p.entry + exit) * p.qty * BASE.feePct, net = pnl(p, exit) - fees;
      st.balance += net;
      st.closed.unshift({ ...p, exit, closedAt: done[2], reason: done[1], net: +net.toFixed(4), fees: +fees.toFixed(4), r: +(net / p.risk).toFixed(2) });
      st.log.unshift(`${stamp(done[2])} zamknięto ${p.base} ${p.side} (${done[1]}) ${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT`);
      st.positions = st.positions.filter(x => x !== p);
    }
  }
  // 2. bezpiecznik dzienny
  const today = new Date(now).toISOString().slice(0, 10);
  if (!st.day || st.day.date !== today) st.day = { date: today, startBalance: st.balance };
  const halted = (st.day.startBalance - st.balance) / st.day.startBalance >= BASE.dailyLossPct;
  // 3. wejścia
  let opened = 0;
  if (!halted) {
    for (const c of candidates(key, res)) {
      if (st.positions.length >= BASE.maxOpen) break;
      const live = byBase.get(E.cleanBase(c.coin.base));
      if (!live || live.qv < BASE.minQv) continue;
      if (st.positions.some(p => E.cleanBase(p.base) === E.cleanBase(c.coin.base))) continue;
      const tgt = c.movePct / 100, stp = c.stopPct / 100;
      if (!(stp > 0.001 && stp < 0.5)) continue;
      const entry = fill(live.price, c.side, true);
      const risk = st.balance * BASE.riskPct;
      let qty = risk / (entry * stp);
      const room = st.balance * BASE.maxLeverage - st.positions.reduce((a, p) => a + p.entry * p.qty, 0);
      if (room <= st.balance * 0.05) break;
      if (qty * entry > room) qty = room / entry;
      st.positions.push({
        id: `${now}-${live.sym}`, base: c.coin.base, sym: live.sym, side: c.side, iv: c.iv, mode: c.mode, openedAt: now, end: now + H_MS[c.iv],
        entry, qty, target: c.side === 'LONG' ? entry * (1 + tgt) : entry * (1 - tgt), stop: c.side === 'LONG' ? entry * (1 - stp) : entry * (1 + stp),
        risk: qty * entry * stp, p: +c.p.toFixed(3), ev: +c.ev.toFixed(2),
      });
      st.log.unshift(`${stamp(now)} otwarto ${c.coin.base} ${c.side} (${c.iv === '1h' ? '24 godz.' : '3 dni'}, ${c.mode === 'big' ? '2:1' : '1:1'}) po ${entry.toPrecision(5)}`);
      opened++;
    }
  } else st.log.unshift(`${stamp(now)} dzienny limit straty – brak nowych wejść do końca dnia`);
  // 4. saldo
  const unreal = st.positions.reduce((a, p) => { const l = byBase.get(E.cleanBase(p.base)); return a + (l ? pnl(p, l.price) : 0); }, 0);
  st.equity.push([now, +st.balance.toFixed(2), +(st.balance + unreal).toFixed(2)]);
  st.equity = st.equity.slice(-24 * 90); st.closed = st.closed.slice(0, 1000); st.log = st.log.slice(0, 200);
  return `${key} ${ACCOUNTS[key].name}: saldo ${st.balance.toFixed(2)}, otwarte ${st.positions.length}, nowe ${opened}${halted ? ', limit dzienny' : ''}`;
}

async function main() {
  const now = Date.now();
  const res = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'results.json'), 'utf8'));
  let prev = await loadState();
  // przejście ze starego formatu (jedno konto) – staje się kontem A
  if (prev && !prev.accounts && prev.balance !== undefined) prev = { accounts: { A: prev } };
  const state = { cfg: BASE, accounts: {} };
  for (const key of Object.keys(ACCOUNTS)) state.accounts[key] = { ...(prev && prev.accounts && prev.accounts[key] ? prev.accounts[key] : fresh(now)), ...ACCOUNTS[key] };

  const tick = await X.bingxTickers();
  const byBase = new Map(tick.map(t => [E.cleanBase(t.base), t]));
  const cache = new Map();
  const klinesFor = async sym => { if (!cache.has(sym)) { try { cache.set(sym, await X.bingxKlines(sym, '1h', 200)); } catch (e) { cache.set(sym, null); } } return cache.get(sym); };

  for (const key of Object.keys(ACCOUNTS)) console.log('Bot (na sucho) ' + await runAccount(key, state.accounts[key], res, byBase, klinesFor, now));
  state.updatedAt = now;
  fs.writeFileSync(path.join(OUT_DIR, 'bot.json'), JSON.stringify(state));
}

main().catch(e => { console.error('Bot:', e.message); process.exit(0); });
