// Bot „na sucho” (paper trading) – sześć WIRTUALNYCH kont po 1000 USDT, prawdziwe ceny BingX.
// Co godzinę, po skanie: rozlicza pozycje (cel / stop / koniec czasu) i otwiera nowe.
// Konta różnią się tylko sposobem wyboru scenariuszy – żeby na żywo sprawdzić, co najlepiej mnoży kapitał:
//   A „Duży zysk 2:1”        – zielone scenariusze w układzie 2:1
//   B „Częste trafienia 1:1” – zielone scenariusze 1:1, tylko gdy model daje ≥ 55%
//   C „Złoty środek”         – dla każdego coina bot wybiera układ (2:1 albo 1:1) o wyższym oczekiwanym wyniku po kosztach
//   D „Ciągnięcie zysku”     – jak A, ale po dojściu do celu nie zamyka, tylko ciągnie stop za ceną (1R za szczytem), max 2× czas
//   E „Najlepsze z najlepszych” – idealna okazja: układ 2:1 / 1:1 / 1:2 z najwyższym oczekiwanym wynikiem po kosztach (≥ 0,15R),
//                                przy remisie wyższa szansa; ryzyko 0,5% na pozycję, maks. 4 pozycje
//   F „Kopia aplikacji”      – dokładnie te zielone scenariusze, które aplikacja zapisuje w historii (24 godz., 3 dni, 14 dni),
//                                nic więcej; wejście zleceniem z limitem po cenie z aplikacji (ważne 1 godz.), cel i stop
//                                z aplikacji; pomija scenariusz, gdy cena uciekła o ponad 0,2%. Mierzy, ile z wyniku aplikacji
//                                zostaje po kosztach na prawdziwych cenach.
//
// ZASADY ROZLICZANIA (metoda 2, od 16.11.2026) – stosowane do nowych pozycji i dalszej części już otwartych:
// • tylko ZAMKNIĘTE świece; każda świeca przetwarzana dokładnie raz (p.checkedTo = koniec ostatniej przetworzonej),
// • świece 5-minutowe z ostatnich ~25 godz., starsze odcinki świecami 1h,
// • świeca, w której nastąpiło wejście: liczymy w niej tylko stop (nie wiemy, czy ruch był przed, czy po wejściu),
// • cel i stop w tej samej świecy → stop; otwarcie świecy już za stopem → wyjście po cenie otwarcia (luka),
// • ciągnięty stop podnoszony szczytem świecy działa dopiero od następnej świecy,
// • koniec czasu: zamknięcie ostatniej świecy kończącej się przed końcem scenariusza; brak danych → jawny znacznik.
// RYZYKO: 1% equity na pozycję (z kosztami), łącznie maks. 5% equity w otwartych pozycjach, dźwignia łącznie maks. 3×,
// dzienny limit straty 3% equity (dzień wg czasu polskiego) – po przekroczeniu brak nowych wejść do końca dnia.
const fs = require('fs');
const path = require('path');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');

const BASE = {
  startBalance: 1000, riskPct: 0.01, maxOpenRisk: 0.05, maxOpen: 8, maxLeverage: 3,
  feePct: 0.0005, slipPct: 0.0005, dailyLossPct: 0.03, minQv: 3e5,
  // 3 dni wstrzymane 17.11.2026: w teście z ostatnich 3 tygodni i longi, i shorty na minusie, na żywo 23% trafień.
  // 24 godz. w tym samym okresie na plus w obu kierunkach. Do ponownej oceny na przeglądzie.
  horizons: ['1h'],
  maxResultsAgeMs: 3 * 36e5, // starsze wyniki skanu → brak nowych wejść
  dayTZ: 'Europe/Warsaw', method: 2,
  // tryb obserwacji (brak nowych wejść, wyjście tylko ręcznie: BOT_RESUME=1): spadek equity od szczytu ≥ 10%
  // albo suma wyników ostatnich 30 transakcji ≤ −10R (model wyraźnie gorszy niż w teście)
  observeDD: 0.10, observeN: 30, observeR: -10,
};
const ACCOUNTS = {
  A: { name: 'Duży zysk 2:1', desc: 'Zielone scenariusze w układzie 2:1 (cel 2× dalej niż stop).' },
  B: { name: 'Częste trafienia 1:1', desc: 'Zielone scenariusze w układzie 1:1, tylko gdy model daje co najmniej 55%.' },
  C: { name: 'Złoty środek', desc: 'Dla każdego coina bot sam wybiera układ 2:1 albo 1:1 – ten o wyższym oczekiwanym wyniku po kosztach.' },
  D: { name: 'Ciągnięcie zysku', desc: 'Jak A, ale po dojściu do celu pozycja zostaje otwarta, a stop idzie za ceną (zabezpiecza zysk). Pomija scenariusze ze stopem bliżej niż 1,3%.' },
  E: { name: 'Najlepsze z najlepszych', desc: 'Idealna okazja dla każdego scenariusza: model porównuje układy 2:1, 1:1 i 1:2 i bierze ten z najwyższym oczekiwanym zyskiem po kosztach (łączy szansę trafienia z wielkością wygranej). Tylko scenariusze z oczekiwanym wynikiem ≥ +0,15R. W układzie 2:1 po dojściu do celu ciągnie zysk jak konto D. Dodatkowo gra z trendem na świecach dziennych – wybicie 55 dni albo odbicie do EMA20 przy słabym wolumenie (longi i shorty), ciągnięty stop, do 42 dni. Połowa ryzyka (0,5% na pozycję), maks. 6 pozycji 24 godz. + 3 trendowe.', riskPct: 0.005, maxOpen: 6, maxTrend: 3 },
  F: { name: 'Kopia aplikacji', desc: 'Gra dokładnie te zielone scenariusze, które widzisz w aplikacji i w historii (24 godz., 3 dni i 14 dni) – nic więcej. Wejście zleceniem z limitem po cenie podanej w aplikacji (ważne 1 godzinę), cel i stop takie same jak w aplikacji. Jeśli cena uciekła o ponad 0,2%, scenariusz jest pomijany. Dzięki temu widać, ile z wyniku aplikacji zostaje po prowizjach. Ryzyko 1% na pozycję, maks. 10 pozycji (łącznie do 10% equity w otwartych pozycjach).', riskPct: 0.01, maxOpen: 10, maxOpenRisk: 0.10, copy: true },
};
// konto F: maks. pogorszenie ceny względem aplikacji i czas ważności zlecenia z limitem
const COPY = { maxSlip: 0.002, limitMs: 36e5 };
// Reset kont przy zmianie zasad: poprzedni okres trafia do archiwum w tym samym pliku (nic nie jest kasowane)
const RESET_TAG = '2026-11-17-metoda2';
const RESET_NOTE = 'Nowe zasady od 17.11.2026: rozliczanie na świecach 5-min (każda raz), przewaga ≥ 8 pkt, tylko 24 godz., limit ryzyka 5%, bez powtórek po stopie.';
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'out');
const H_MS = { '1h': 24 * 36e5, '4h': 72 * 36e5, '1d': 42 * 864e5 };
const IV_LABEL = { '1h': '24 godz.', '4h': '3 dni', '1d': '14 dni' };
const M5 = 5 * 6e4, H1 = 36e5;

// ---------- stan: odczyt i zapis ----------
// BOT_IN = plik z poprzednim stanem (workflow pobiera go z gałęzi „data”), BOT_PREV_STATUS = ok | missing | error.
// Pierwszy start tylko wtedy, gdy poprzedniego stanu NA PEWNO nie ma (missing) albo BOT_INIT=1. Każdy inny problem = błąd.
function loadState(env = process.env) {
  const status = env.BOT_PREV_STATUS || (env.BOT_IN ? 'ok' : 'missing');
  if (env.BOT_INIT === '1') return null;
  if (status === 'missing') return null;
  if (status !== 'ok' || !env.BOT_IN) throw new Error(`nie udało się pobrać poprzedniego stanu bota (status: ${status}) – przerywam, żeby nie wyzerować kont`);
  if (!fs.existsSync(env.BOT_IN)) throw new Error('brak pliku z poprzednim stanem bota – przerywam');
  let st;
  try { st = JSON.parse(fs.readFileSync(env.BOT_IN, 'utf8')); } catch (e) { throw new Error('uszkodzony plik stanu bota: ' + e.message); }
  validateState(st);
  return st;
}
function validateState(st) {
  if (!st || typeof st !== 'object') throw new Error('stan bota: brak obiektu');
  if (!st.accounts && st.balance !== undefined) return; // stary format (jedno konto) – migracja w main
  if (!st.accounts || typeof st.accounts !== 'object') throw new Error('stan bota: brak kont');
  for (const [k, a] of Object.entries(st.accounts)) {
    if (!isFinite(a.balance) || a.balance <= 0) throw new Error(`stan bota: konto ${k} ma niepoprawne saldo`);
    if (!Array.isArray(a.positions) || !Array.isArray(a.closed)) throw new Error(`stan bota: konto ${k} – uszkodzone listy pozycji`);
  }
}
function saveState(file, state) {
  validateState(state);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file); // zapis atomowy
}
const fresh = now => ({ startedAt: now, balance: BASE.startBalance, positions: [], closed: [], equity: [], day: null, log: [] });

// ---------- pomocnicze ----------
const fill = (px, side, opening) => px * ((side === 'LONG') === opening ? 1 + BASE.slipPct : 1 - BASE.slipPct);
const pnl = (p, px) => (p.side === 'LONG' ? px - p.entry : p.entry - px) * p.qty;
const stamp = t => new Date(t).toISOString().slice(0, 16);
const dayKey = (t, tz = BASE.dayTZ) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const costPerUnit = px => px * 2 * (BASE.feePct + BASE.slipPct); // wejście + wyjście
// możliwa strata pozycji przy stopie (z kosztami); po przesunięciu stopu na zysk – 0
const openRisk = p => Math.max(0, (p.side === 'LONG' ? p.entry - p.stop : p.stop - p.entry) * p.qty) + costPerUnit(p.entry) * p.qty;
const unrealized = (st, byBase) => st.positions.reduce((a, p) => {
  const l = byBase.get(E.cleanBase(p.base));
  return a + (l ? pnl(p, l.price) - costPerUnit(p.entry) * p.qty : -costPerUnit(p.entry) * p.qty);
}, 0);

// świece → lista zamkniętych barów { t, dur, o, h, l, c }; 1h tylko dla okresu przed pierwszą świecą 5m
function mergeBars(k1h, k5m, now) {
  const bars = [];
  const first5 = k5m && k5m.t.length ? k5m.t[0] : Infinity;
  if (k1h) for (let i = 0; i < k1h.t.length; i++) if (k1h.t[i] + H1 <= first5 && k1h.t[i] + H1 <= now) bars.push({ t: k1h.t[i], dur: H1, o: k1h.o[i], h: k1h.h[i], l: k1h.l[i], c: k1h.c[i] });
  if (k5m) for (let i = 0; i < k5m.t.length; i++) if (k5m.t[i] + M5 <= now) bars.push({ t: k5m.t[i], dur: M5, o: k5m.o[i], h: k5m.h[i], l: k5m.l[i], c: k5m.c[i] });
  return bars.sort((a, b) => a.t - b.t);
}

// ---------- rozliczenie jednej pozycji na barach (czysta funkcja, testowana) ----------
// zwraca { done: [cena, powód, czas, extra] | null } i aktualizuje p.checkedTo / p.stop / p.best / p.lastClose
function settle(p, bars, now) {
  const L = p.side === 'LONG';
  let done = null;
  if (p.checkedTo === undefined || p.checkedTo < p.openedAt - H1) p.checkedTo = p.openedAt;
  for (const b of bars) {
    const bEnd = b.t + b.dur;
    if (bEnd <= p.checkedTo) continue;            // już przetworzona (każda świeca tylko raz)
    if (b.t < p.checkedTo && b.t >= p.openedAt) continue; // nakłada się z przetworzonym odcinkiem (inna rozdzielczość)
    if (bEnd > now) break;                        // świeca jeszcze trwa
    if (bEnd > p.end) break;                      // kończy się po końcu scenariusza
    const entryBar = b.t < p.openedAt;            // świeca, w której nastąpiło wejście
    // 1) stop – z uwzględnieniem luki
    const hitS = L ? b.l <= p.stop : b.h >= p.stop;
    if (hitS) {
      const gap = !entryBar && (L ? b.o < p.stop : b.o > p.stop);
      done = [gap ? b.o : p.stop, p.trailing ? 'ciągnięty stop' : 'stop', bEnd, gap ? { gap: true } : null];
      p.checkedTo = bEnd; break;
    }
    // 2) cel (nie w świecy wejścia – nie wiemy, czy ruch był po wejściu)
    if (!entryBar && !p.trail) {
      const hitT = L ? b.h >= p.target : b.l <= p.target;
      if (hitT) { done = [p.target, 'cel', bEnd, null]; p.checkedTo = bEnd; break; }
    }
    // 3) ciągnięty stop: nowy poziom obowiązuje od następnej świecy
    if (p.chandelier && !entryBar) {
      // tylko na zamknięciu dnia (UTC): najlepsze zamknięcie − rDist, jak w teście na historii
      if ((b.t + b.dur) % 864e5 === 0) {
        p.best = L ? Math.max(p.best || p.entry, b.c) : Math.min(p.best || p.entry, b.c);
        const ns = L ? p.best - p.rDist : p.best + p.rDist;
        if (L ? ns > p.stop : ns < p.stop) { p.stop = ns; p.trailing = true; }
      }
    } else if (p.trail && !entryBar) {
      p.best = L ? Math.max(p.best || p.entry, b.h) : Math.min(p.best || p.entry, b.l);
      if (L ? p.best >= p.target : p.best <= p.target) {
        const ns = L ? p.best - p.rDist : p.best + p.rDist;
        if (L ? ns > p.stop : ns < p.stop) { p.stop = ns; p.trailing = true; }
      }
    }
    if (!entryBar) p.lastClose = b.c;
    p.checkedTo = bEnd;
  }
  // 4) koniec czasu
  if (!done && now >= p.end) {
    const covered = p.checkedTo >= p.end - H1; // dane prawie do końca scenariusza
    if (covered && p.lastClose !== undefined) done = [p.lastClose, 'czas minął', p.end, null];
    else if (now >= p.end + 3 * H1) {
      if (p.lastClose !== undefined) done = [p.lastClose, 'czas minął (niepełne dane)', p.end, { noData: true }];
      else return { done: null, needLive: true };
    }
  }
  return { done };
}

// ---------- kandydaci dla każdego konta ----------
function candidates(key, res) {
  const out = [];
  for (const iv of BASE.horizons) {
    const big = E.rankTop(res.coins, iv, 'all', 15, 'big').filter(r => r.tier === 0);
    const eq = E.rankTop(res.coins, iv, 'all', 15, 'equal').filter(r => r.tier === 0 && r.d.p >= 0.55);
    const mk = (r, mode) => {
      const mv = Math.abs(r.d.movePct) / 100, sp = Math.abs(r.d.stopPct) / 100, c = 2 * (BASE.feePct + BASE.slipPct);
      // oczekiwany wynik w R po kosztach: p·(cel−koszty) − (1−p)·(stop+koszty), w jednostkach stopu.
      // Przybliżenie: zakończenia po czasie liczone jak brak wyniku (0 R) – nie znamy ich rozkładu dla każdego coina.
      const ev = sp > 0 ? (r.d.p * (mv - c) - (1 - r.d.p) * (sp + c)) / sp : -1;
      return { coin: r.coin, iv, side: r.d.dir, p: r.d.p, mode, lift: r.lift, movePct: mv * 100, stopPct: sp * 100, ev, signalPrice: r.coin.res[iv].price, tickerPrice: r.coin.price };
    };
    if (key === 'A') big.forEach(r => out.push(mk(r, 'big')));
    if (key === 'D') big.forEach(r => { const c = mk(r, 'big'); if (c.stopPct >= 1.3) out.push(c); });
    if (key === 'B') eq.forEach(r => out.push(mk(r, 'equal')));
    if (key === 'E' && iv === BASE.horizons[0]) {
      // E dodatkowo: sygnały „z trendem” ze świec dziennych (wybicie 55 dni, ciągnięty stop 3×ATR, bez stałego celu)
      for (const coin of res.coins) {
        const ts = coin.res && coin.res['1d'] && coin.res['1d'].trendSig; if (!ts) continue;
        out.push({ coin, iv: '1d', side: ts.side, p: 0, mode: 'trend', lift: 0, movePct: 0, stopPct: ts.stopPct, ev: 0.12, signalPrice: ts.price, tickerPrice: coin.price, trendSig: ts });
      }
    }
    if (key === 'E') {
      // idealna okazja dla każdego coina: spośród układów 2:1 / 1:1 / 1:2, które zdały test, ten z najwyższym
      // oczekiwanym wynikiem po kosztach (szansa × wielkość wygranej − strata); przy remisie (±0,03R) wyższa szansa.
      // Tylko scenariusze z wyraźnym zyskiem oczekiwanym (≥ 0,15R).
      const m = new Map();
      for (const mode of ['big', 'equal', 'safe']) for (const r of E.rankTop(res.coins, iv, 'all', 30, mode).filter(r => r.tier === 0)) {
        const c = mk(r, mode); if (c.ev < 0.15) continue;
        const k = c.coin.base + iv, o = m.get(k);
        if (!o || c.ev > o.ev + 0.03 || (Math.abs(c.ev - o.ev) <= 0.03 && c.p > o.p)) m.set(k, c);
      }
      out.push(...m.values());
    }
    if (key === 'C') {
      const m = new Map();
      for (const c of [...big.map(r => mk(r, 'big')), ...eq.map(r => mk(r, 'equal'))]) {
        const k = c.coin.base + iv; if (!m.has(k) || c.ev > m.get(k).ev) m.set(k, c);
      }
      for (const c of m.values()) if (c.ev >= 0.1) out.push(c);
    }
  }
  return out.sort((a, b) => (key === 'C' || key === 'E' ? b.ev - a.ev : b.lift - a.lift));
}

// tryb obserwacji: zwraca powód albo null
function observeCheck(st, equity) {
  const peak = Math.max(st.peakEquity || BASE.startBalance, equity);
  if ((peak - equity) / peak >= BASE.observeDD) return `spadek equity ${((peak - equity) / peak * 100).toFixed(1)}% od szczytu`;
  const last = st.closed.slice(0, BASE.observeN);
  if (last.length >= BASE.observeN) { const sum = last.reduce((a, p) => a + (p.r || 0), 0); if (sum <= BASE.observeR) return `ostatnie ${BASE.observeN} transakcji: ${sum.toFixed(1)}R`; }
  return null;
}

// walidacja wejścia – zwraca powód odrzucenia albo null
function rejectEntry(c, live, now, resAgeMs) {
  if (resAgeMs > BASE.maxResultsAgeMs) return 'nieaktualne wyniki skanu';
  if (!live || !(live.price > 0) || !isFinite(live.price)) return 'brak ceny';
  if (live.qv < BASE.minQv) return 'mały obrót';
  // spread: połowa spreadu to koszt wejścia ponad model kosztów – odrzucamy, gdy przekracza zakładany poślizg
  if (live.bid > 0 && live.ask > 0 && (live.ask - live.bid) / 2 / live.price > BASE.slipPct) return 'za szeroki spread';
  if (c.side !== 'LONG' && c.side !== 'SHORT') return 'zły kierunek';
  const stp = c.stopPct / 100, tgt = c.movePct / 100;
  if (!(stp > 0.001 && stp < 0.5) || (c.mode !== 'trend' && !(tgt > 0 && tgt < 1))) return 'zły cel/stop';
  if (c.mode === 'trend' && c.trendSig && now - c.trendSig.t > 2 * 864e5) return 'stary sygnał trendu';
  // cena uciekła od chwili sygnału o więcej niż połowę odległości stopu → scenariusz nieaktualny
  const ref = c.tickerPrice > 0 ? c.tickerPrice : c.signalPrice;
  if (ref > 0 && Math.abs(live.price / ref - 1) > stp * 0.5) return 'cena uciekła od sygnału';
  return null;
}

// ---------- konto F: kopia aplikacji ----------
// nowe zielone scenariusze z historii aplikacji (zapisane po ostatnim uruchomieniu konta)
function copyCandidates(st, hist, now) {
  const since = st.lastPickT || now - 30 * 6e4;
  return (hist || []).filter(p => p.method === 2 && p.status === 'open' && p.t > since && p.t <= now && p.end > now
    && p.price > 0 && p.target > 0 && p.stop > 0 && (p.dir === 'LONG' || p.dir === 'SHORT'))
    .sort((a, b) => (b.lift || 0) - (a.lift || 0));
}
// zlecenie z limitem: pierwsza ZAMKNIĘTA świeca, która zaczęła się po złożeniu zlecenia i dotknęła limitu.
// Świecy, w której złożono zlecenie, nie liczymy (nie wiemy, czy dołek był przed, czy po). Otwarcie świecy
// już po lepszej stronie limitu → wykonanie po cenie otwarcia (tak działa zlecenie z limitem).
function limitFill(o, bars, now) {
  const L = o.side === 'LONG';
  for (const b of bars) {
    if (b.t < o.placedAt) continue;
    if (b.t >= o.expires || b.t + b.dur > now) break;
    if (L ? b.l <= o.limit : b.h >= o.limit) return { t: b.t + 1, px: (L ? b.o < o.limit : b.o > o.limit) ? b.o : o.limit };
  }
  return null;
}
// otwarcie pozycji F (cel i stop z aplikacji, wielkość wg ryzyka konta) – zwraca pozycję albo powód odrzucenia
function copyOpen(st, o, entry, t, byBase, key) {
  const A = ACCOUNTS[key], riskPct = A.riskPct || BASE.riskPct, L = o.side === 'LONG';
  if (L ? !(o.stop < entry && entry < o.target) : !(o.target < entry && entry < o.stop)) return 'cena poza celem/stopem';
  const dist = Math.abs(entry - o.stop), eqNow = st.balance + unrealized(st, byBase);
  let qty = eqNow * riskPct / (dist + costPerUnit(entry));
  const riskRoom = eqNow * (A.maxOpenRisk || BASE.maxOpenRisk) - st.positions.reduce((a, p) => a + openRisk(p), 0);
  if (riskRoom <= eqNow * riskPct * 0.3) return 'limit łącznego ryzyka';
  qty = Math.min(qty, riskRoom / (dist + costPerUnit(entry)));
  const room = eqNow * BASE.maxLeverage - st.positions.reduce((a, p) => a + p.entry * p.qty, 0);
  if (room <= eqNow * 0.05) return 'limit dźwigni';
  if (qty * entry > room) qty = room / entry;
  if (!(qty > 0) || !isFinite(qty)) return 'zła wielkość pozycji';
  const pos = { id: `${t}-${o.sym}`, base: o.base, sym: o.sym, side: o.side, iv: o.iv, mode: 'copy', openedAt: t, end: o.end,
    entry, qty, target: o.target, stop: o.stop, p: o.p || 0, ev: 0, lift: o.lift || 0, costR: +(costPerUnit(entry) / dist).toFixed(3),
    checkedTo: t, method: BASE.method, appPrice: o.limit, pickId: o.pickId, fillType: o.fillType || 'limit', spreadPct: o.spreadPct ?? null };
  pos.risk = openRisk(pos);
  st.positions.push(pos);
  st.log.unshift(`${stamp(t)} otwarto ${o.base} ${o.side} (${IV_LABEL[o.iv] || o.iv}, kopia aplikacji 2:1) po ${entry.toPrecision(5)}${pos.fillType === 'limit' ? ' (zlecenie z limitem)' : ''}`);
  return pos;
}
// 0. czekające zlecenia z limitem: wykonane → pozycja, po czasie → anulowane
async function copyFills(key, st, barsFor, byBase, now) {
  st.pending = st.pending || [];
  for (const o of [...st.pending]) {
    const f = limitFill(o, (await barsFor(o.sym)) || [], now);
    if (f) {
      const r = copyOpen(st, o, f.px, f.t, byBase, key);
      if (typeof r === 'string') st.log.unshift(`${stamp(now)} zlecenie ${o.base} ${o.side} wykonane, ale pominięte: ${r}`);
      st.pending = st.pending.filter(x => x !== o);
    } else if (now >= o.expires) {
      st.log.unshift(`${stamp(now)} zlecenie z limitem ${o.base} ${o.side} po ${o.limit.toPrecision(5)} wygasło – cena nie wróciła`);
      st.pending = st.pending.filter(x => x !== o);
    }
  }
}
// 3. nowe wejścia F
function copyEntries(key, st, hist, byBase, now, skip) {
  st.pending = st.pending || [];
  const picks = copyCandidates(st, hist, now);
  st.lastPickT = Math.max(st.lastPickT || now - 30 * 6e4, ...picks.map(p => p.t));
  let opened = 0;
  for (const p of picks) {
    const live = byBase.get(E.cleanBase(p.base));
    if (!live || !(live.price > 0)) { skip('brak coina na BingX'); continue; }
    if (st.positions.length + st.pending.length >= ACCOUNTS[key].maxOpen) { skip('maks. liczba pozycji'); continue; }
    const cb = E.cleanBase(p.base);
    if (st.positions.some(x => E.cleanBase(x.base) === cb) || st.pending.some(x => E.cleanBase(x.base) === cb)) { skip('już otwarta pozycja na coinie'); continue; }
    const L = p.dir === 'LONG', worse = L ? live.price / p.price - 1 : 1 - live.price / p.price;
    if (worse > COPY.maxSlip) { skip('cena uciekła o ponad 0,2%'); continue; }
    const o = { id: `${now}-${live.sym}`, pickId: p.id, base: p.base, sym: live.sym, side: p.dir, iv: p.iv, limit: p.price, target: p.target, stop: p.stop,
      end: p.end, placedAt: now, expires: now + COPY.limitMs, p: p.p, lift: p.lift,
      spreadPct: live.bid > 0 && live.ask > 0 ? +((live.ask - live.bid) / live.price * 100).toFixed(3) : null };
    if (worse <= 0) {
      // cena już po lepszej stronie limitu → zlecenie wykonuje się od razu po cenie rynkowej (z poślizgiem, nie gorzej niż limit)
      const px = L ? Math.min(fill(live.price, 'LONG', true), p.price) : Math.max(fill(live.price, 'SHORT', true), p.price);
      const r = copyOpen(st, { ...o, fillType: 'od razu' }, px, now, byBase, key);
      if (typeof r === 'string') skip(r); else opened++;
    } else {
      st.pending.push(o);
      st.log.unshift(`${stamp(now)} zlecenie z limitem ${p.base} ${p.dir} po ${p.price.toPrecision(5)} (cena teraz ${live.price.toPrecision(5)}, ${IV_LABEL[p.iv] || p.iv})`);
      skip('czeka zlecenie z limitem');
    }
  }
  return opened;
}

async function runAccount(key, st, res, byBase, barsFor, now) {
  const riskPct = ACCOUNTS[key].riskPct || BASE.riskPct, maxOpen = ACCOUNTS[key].maxOpen || BASE.maxOpen;
  // 0. dzień (czas polski) – baza dnia = equity PRZED rozliczeniem tego skanu
  const today = dayKey(now);
  if (!st.day || st.day.date !== today) st.day = { date: today, startEquity: +(st.balance + unrealized(st, byBase)).toFixed(4), halted: false };
  if (st.day.startEquity === undefined) st.day.startEquity = st.day.startBalance || st.balance; // stary format
  // 0b. konto F: wykonanie / wygaśnięcie zleceń z limitem (przed rozliczeniem – nowa pozycja rozlicza się od świecy wejścia)
  if (ACCOUNTS[key].copy) await copyFills(key, st, barsFor, byBase, now);
  // 1. rozliczanie
  for (const p of [...st.positions]) {
    const bars = await barsFor(p.sym);
    let { done, needLive } = settle(p, bars || [], now);
    const live = byBase.get(E.cleanBase(p.base));
    if (needLive && live) done = [live.price, 'czas minął (brak danych świec)', now, { noData: true }];
    if (done) {
      const exit = fill(done[0], p.side, false), fees = (p.entry + exit) * p.qty * BASE.feePct, net = pnl(p, exit) - fees;
      st.balance += net;
      st.closed.unshift({ ...p, exit, closedAt: done[2], reason: done[1], net: +net.toFixed(4), fees: +fees.toFixed(4), r: +(net / p.risk).toFixed(2), method: BASE.method, ...(done[3] || {}) });
      st.log.unshift(`${stamp(Math.min(done[2], now))} zamknięto ${p.base} ${p.side} (${done[1]}) ${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT`);
      st.positions = st.positions.filter(x => x !== p);
    }
  }
  // 2. dzienny limit straty – na equity (saldo + wynik otwartych pozycji po kosztach), blokada do końca dnia
  const equity = st.balance + unrealized(st, byBase);
  if (!st.day.halted && (st.day.startEquity - equity) / st.day.startEquity >= BASE.dailyLossPct) {
    st.day.halted = true; st.log.unshift(`${stamp(now)} dzienny limit straty (−${(BASE.dailyLossPct * 100).toFixed(0)}% equity) – brak nowych wejść do końca dnia`);
  }
  // 2b. tryb obserwacji – pogorszenie wyników
  const obs = observeCheck(st, equity);
  if (obs && !st.observe) { st.observe = { since: now, reason: obs }; st.log.unshift(`${stamp(now)} TRYB OBSERWACJI: ${obs} – brak nowych wejść do ręcznego wznowienia`); }
  if (st.observe && process.env.BOT_RESUME === '1') { st.log.unshift(`${stamp(now)} wznowiono handel (ręcznie)`); st.observe = null; st.peakEquity = equity; }
  // 3. wejścia (z zapisem powodów odrzucenia)
  let opened = 0; const resAge = now - Date.parse(res.generatedAt || 0); const rej = {};
  const skip = r => { rej[r] = (rej[r] || 0) + 1; };
  if (st.day.halted) skip('dzienny limit straty');
  else if (st.observe) skip('tryb obserwacji');
  else if (ACCOUNTS[key].copy) opened = copyEntries(key, st, res.history, byBase, now, skip);
  else {
    for (const c of candidates(key, res)) {
      // konto E: pozycje trendowe (dzienne, długie) mają osobną pulę 3 miejsc, żeby nie wypychały transakcji 24 godz.
      // (symulacja 18.11.2026: wspólna pula obniżała wynik E z ok. +8,6% do +4,5% mies.)
      const isTrend = c.mode === 'trend', nTrend = st.positions.filter(p => p.mode === 'trend').length;
      if (isTrend ? nTrend >= (ACCOUNTS[key].maxTrend || 0) : st.positions.length - nTrend >= maxOpen) { skip(isTrend ? 'maks. pozycji trendowych' : 'maks. liczba pozycji'); continue; }
      const live = byBase.get(E.cleanBase(c.coin.base));
      const why = rejectEntry(c, live, now, resAge); if (why) { skip(why); continue; }
      if (st.positions.some(p => E.cleanBase(p.base) === E.cleanBase(c.coin.base))) { skip('już otwarta pozycja na coinie'); continue; }
      // ten sam coin w tym samym kierunku dopiero po upływie horyzontu poprzedniej pozycji (jak w teście na historii)
      if (st.closed.some(p => E.cleanBase(p.base) === E.cleanBase(c.coin.base) && p.side === c.side && (p.mode === 'trend' ? (p.closedAt || 0) + 864e5 : p.openedAt + H_MS[p.iv]) > now)) { skip('przerwa po poprzedniej pozycji'); continue; }
      const tgt = c.movePct / 100, stp = c.stopPct / 100;
      // ciągnięcie zysku: konto D zawsze; konto E tylko w układzie 2:1 – tylko tam sprawdziliśmy je w teście na historii
      // (24 godz.: +0,15R → +0,42R na transakcję); przy 1:1 i 1:2 E zamyka na celu
      const trail = key === 'D' || (key === 'E' && c.mode === 'big');
      const chand = c.mode === 'trend'; // stop ciągnięty od wejścia, aktualizowany tylko na zamknięciach dnia
      const entry = fill(live.price, c.side, true);
      const eqNow = st.balance + unrealized(st, byBase);
      // wielkość pozycji: 1% equity na stratę przy stopie WRAZ z kosztami wejścia i wyjścia
      let qty = (eqNow * riskPct) / (entry * stp + costPerUnit(entry));
      // limit łącznego ryzyka otwartych pozycji
      const riskRoom = eqNow * BASE.maxOpenRisk - st.positions.reduce((a, p) => a + openRisk(p), 0);
      if (riskRoom <= eqNow * riskPct * 0.3) { skip('limit łącznego ryzyka'); break; }
      qty = Math.min(qty, riskRoom / (entry * stp + costPerUnit(entry)));
      // limit dźwigni
      const room = eqNow * BASE.maxLeverage - st.positions.reduce((a, p) => a + p.entry * p.qty, 0);
      if (room <= eqNow * 0.05) { skip('limit dźwigni'); break; }
      if (qty * entry > room) qty = room / entry;
      const pos = {
        id: `${now}-${live.sym}`, base: c.coin.base, sym: live.sym, side: c.side, iv: c.iv, mode: c.mode, openedAt: now, end: now + (chand ? H_MS['1d'] : H_MS[c.iv] * (trail ? 2 : 1)),
        entry, qty, target: chand ? (c.side === 'LONG' ? entry * 1e6 : entry * 1e-6) : c.side === 'LONG' ? entry * (1 + tgt) : entry * (1 - tgt), stop: c.side === 'LONG' ? entry * (1 - stp) : entry * (1 + stp),
        p: +c.p.toFixed(3), ev: +c.ev.toFixed(2), lift: +c.lift.toFixed(3), costR: +(costPerUnit(entry) / (entry * stp)).toFixed(3), checkedTo: now, method: BASE.method,
        ...(live.bid > 0 ? { spreadPct: +((live.ask - live.bid) / live.price * 100).toFixed(3) } : { spreadPct: null }),
        ...(trail ? { trail: true, rDist: entry * stp, best: entry } : {}),
        ...(chand ? { trail: true, chandelier: true, rDist: entry * ((c.trendSig && c.trendSig.trailPct) || c.stopPct) / 100, best: entry, setup: c.trendSig && c.trendSig.kind } : {}),
      };
      pos.risk = openRisk(pos);
      if (!(pos.qty > 0) || !isFinite(pos.qty) || (pos.side === 'LONG' ? !(pos.stop < pos.entry && pos.entry < pos.target) : !(pos.target < pos.entry && pos.entry < pos.stop))) continue;
      st.positions.push(pos);
      st.log.unshift(`${stamp(now)} otwarto ${c.coin.base} ${c.side} (${c.iv === '1h' ? '24 godz.' : c.iv === '1d' ? 'do 42 dni' : '3 dni'}, ${c.mode === 'trend' ? 'z trendem: ' + ((c.trendSig && c.trendSig.kind) || 'dzienne') : c.mode === 'big' ? '2:1' : c.mode === 'safe' ? '1:2' : '1:1'}) po ${entry.toPrecision(5)}`);
      opened++;
    }
  }
  // 4. saldo, equity, ryzyko
  const eqEnd = st.balance + unrealized(st, byBase);
  st.openRiskPct = +(st.positions.reduce((a, p) => a + openRisk(p), 0) / eqEnd * 100).toFixed(2);
  st.peakEquity = Math.max(st.peakEquity || BASE.startBalance, eqEnd);
  st.lastScan = { at: now, opened, rejected: rej, long: st.positions.filter(p => p.side === 'LONG').length, short: st.positions.filter(p => p.side === 'SHORT').length };
  st.equity.push([now, +st.balance.toFixed(2), +eqEnd.toFixed(2)]);
  st.equity = st.equity.slice(-24 * 90); st.closed = st.closed.slice(0, 1000); st.log = st.log.slice(0, 200);
  return `${key} ${ACCOUNTS[key].name}: saldo ${st.balance.toFixed(2)}, equity ${eqEnd.toFixed(2)}, otwarte ${st.positions.length} (ryzyko ${st.openRiskPct}%), nowe ${opened}${st.day.halted ? ', limit dzienny' : ''}`;
}

async function main() {
  const now = Date.now();
  const res = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'results.json'), 'utf8'));
  // historia zielonych scenariuszy aplikacji (zapisana przez skaner w tym samym przebiegu) – dla konta F
  try { res.history = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'history.json'), 'utf8')); } catch (e) { res.history = []; console.log('Bot: brak historii aplikacji – konto F bez nowych wejść'); }
  let prev = loadState();
  if (prev && !prev.accounts && prev.balance !== undefined) prev = { accounts: { A: prev } }; // stary format
  if (!prev) console.log('Bot: pierwszy start – nowe konta po 1000 USDT');
  const state = { cfg: BASE, version: 2, resetTag: RESET_TAG, resetNote: RESET_NOTE, archive: (prev && prev.archive) || [], accounts: {} };
  if (prev && prev.accounts && prev.resetTag !== RESET_TAG) {
    // archiwum poprzedniego okresu: podsumowanie + wszystkie zamknięte transakcje i pozycje otwarte w chwili resetu
    state.archive.unshift({ tag: prev.resetTag || 'start', until: now, accounts: Object.fromEntries(Object.entries(prev.accounts).map(([k, a]) => [k, {
      name: a.name, startedAt: a.startedAt, balance: a.balance, closed: a.closed, openAtReset: a.positions,
      n: a.closed.length, wins: a.closed.filter(p => p.net > 0).length, net: +a.closed.reduce((x, p) => x + p.net, 0).toFixed(2) }])) });
    console.log('Bot: reset kont (nowe zasady) – poprzedni okres zapisany w archiwum');
    prev = null;
  }
  for (const key of Object.keys(ACCOUNTS)) state.accounts[key] = { ...(prev && prev.accounts && prev.accounts[key] ? prev.accounts[key] : fresh(now)), ...ACCOUNTS[key] };

  const tick = await X.bingxTickers();
  if (!tick.length) throw new Error('brak tickerów BingX');
  const byBase = new Map(tick.map(t => [E.cleanBase(t.base), t]));
  const cache = new Map();
  const barsFor = async sym => {
    if (!cache.has(sym)) {
      let k1 = null, k5 = null;
      try { k1 = await X.bingxKlines(sym, '1h', 200); } catch (e) { }
      try { k5 = await X.bingxKlines(sym, '5m', 300); } catch (e) { }
      cache.set(sym, mergeBars(k1, k5, now));
    }
    return cache.get(sym);
  };

  for (const key of Object.keys(ACCOUNTS)) console.log('Bot (na sucho) ' + await runAccount(key, state.accounts[key], res, byBase, barsFor, now));
  state.updatedAt = now;
  saveState(path.join(OUT_DIR, 'bot.json'), state);
}

if (require.main === module) main().catch(e => { console.error('Bot – błąd:', e.message); process.exit(1); });
module.exports = { limitFill, copyCandidates, observeCheck, settle, mergeBars, loadState, saveState, validateState, runAccount, rejectEntry, dayKey, openRisk, BASE, H_MS };
