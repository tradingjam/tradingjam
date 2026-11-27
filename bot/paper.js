// Bot „na sucho” (paper trading) – dziewięć WIRTUALNYCH kont po 1000 USDT, prawdziwe ceny BingX.
// Co godzinę, po skanie: rozlicza pozycje (cel / stop / koniec czasu) i otwiera nowe.
// Konta różnią się tylko sposobem wyboru scenariuszy – żeby na żywo sprawdzić, co najlepiej mnoży kapitał:
//   A „Duży zysk 2:1”        – zielone scenariusze w układzie 2:1
//   B „Częste trafienia 1:1” – zielone scenariusze 1:1, tylko gdy model daje ≥ 55%
//   C „Złoty środek”         – dla każdego coina bot wybiera układ (2:1 albo 1:1) o wyższym oczekiwanym wyniku po kosztach
//   D „Ciągnięcie zysku”     – jak A, ale po dojściu do celu nie zamyka, tylko ciągnie stop za ceną (1R za szczytem), max 2× czas
//   E „Najlepsze z najlepszych” – idealna okazja: układ 2:1 / 1:1 / 1:2 z najwyższym oczekiwanym wynikiem po kosztach (≥ 0,15R),
//                                przy remisie wyższa szansa; ryzyko 0,5% na pozycję, maks. 4 pozycje
//   F „Kopia aplikacji”      – dokładnie te zielone scenariusze, które aplikacja zapisuje w historii (24 godz. i 3 dni),
//                                nic więcej; wejście zleceniem z limitem po cenie z aplikacji (ważne 1 godz.), cel i stop
//                                z aplikacji; scenariusze z Binance/OKX wchodzą po cenie BingX z celem i stopem w tych samych procentach. Mierzy, ile z wyniku aplikacji
//                                zostaje po kosztach na prawdziwych cenach.
//   G „Wskaźniki + filtr modelu” – gra z trendem na świecach 1h (EMA20/EMA50, RSI, wolumen, ATR). Trend spadkowy → short,
//                                gdy odbicie do EMA20 na słabym wolumenie gaśnie; trend wzrostowy → long po korekcie do EMA20.
//                                Wejście tylko, gdy model 2:1 daje w tym kierunku ≥ 38% (od 21.11; wcześniej 45% – zero wejść).
//                                Stop za szczytem/dołkiem odbicia, cel 2R, po celu ciągnie zysk. Eksperyment – bez testu na historii.
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
const { VENUES } = require('./venues.js');

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
  F: { name: 'Kopia aplikacji', desc: 'Gra dokładnie te zielone scenariusze, które widzisz w aplikacji i w historii (24 godz. i 3 dni, bez 14 dni) – nic więcej. Wejście zleceniem z limitem po cenie podanej w aplikacji (ważne 1 godzinę), cel i stop takie same jak w aplikacji. Scenariusze z Binance i OKX wchodzą od razu po cenie BingX, z celem i stopem w tych samych procentach co w aplikacji. Dzięki temu widać, ile z wyniku aplikacji zostaje po prowizjach. Ryzyko 1% na pozycję, maks. 10 pozycji (łącznie do 10% equity w otwartych pozycjach).', riskPct: 0.01, maxOpen: 10, maxOpenRisk: 0.10, dailyLossPct: 0.06, copy: true },
  H: { name: 'Kopia aplikacji + ciągnięcie zysku', desc: 'Kandydat na jednego, docelowego bota: to samo co F (dokładnie zielone scenariusze z aplikacji, wejście po cenie z aplikacji, ten sam stop i cel), ale po dojściu do celu NIE zamyka pozycji – stop idzie za ceną 1R za najlepszym poziomem (zysk co najmniej +1R zostaje zabezpieczony), a pozycja może trwać do 2× dłużej niż scenariusz. Pomysł z konta D. Od 27.11.2026 pomija scenariusze 24 godz., w których cel leży przy wsparciu (dla longa: oporze) przetestowanym co najmniej 2 razy w ostatnich 48 godz. – np. short z celem na podwójnym dołku (backtest 513 scenariuszy: takie wejścia średnio −0,15R, reszta +0,27R). Ryzyko 1% na pozycję, maks. 10 pozycji.', riskPct: 0.01, maxOpen: 10, maxOpenRisk: 0.10, dailyLossPct: 0.06, copy: true, trail: true, lvlFilter: true },
  I: { name: 'Trader – wchodzi od razu, potwierdza w 3 godz.', desc: 'Model podsuwa scenariusz (szersza pula niż zielone: przewaga ≥ 5 pkt, 20 najlepszych na skan, 24 godz., układ 2:1). Bot wchodzi od razu po cenie BingX (poziomy celu i stopu w tych samych % co w aplikacji), a potem przez 3 godziny ocenia wykres jak trader: czeka na wybicie szczytu (dołka) 2 ostatnich świec przy co najmniej 2 z 5 punktów (nie łapie spadającego noża, RSI w dobrym zakresie i w kierunku ruchu, cena po właściwej stronie EMA20, wolumen co najmniej średni, trend 4h nie przeciw). Potwierdzenie = pozycja zostaje. Brak potwierdzenia w 3 godz. = stop przesuwa się na cenę wejścia. Po dojściu do celu nie zamyka – połowa drogi do celu zostaje zabezpieczona, a stop idzie za ceną (1R za najlepszym poziomem), pozycja do 48 godz. Ryzyko 1% na pozycję, maks. 10 pozycji. Konto zresetowane 27.11.2026 (nowa zasada wejścia).', riskPct: 0.01, maxOpen: 10, maxOpenRisk: 0.10, dailyLossPct: 0.06, trader: true, early: true, resetTag: '2026-11-27-wczesne' },
  O: { name: 'Kopia aplikacji – tylko OKX Europe', desc: 'Test przed prawdziwym kontem na giełdzie z licencją UE: to samo co F (zielone scenariusze z aplikacji, 24 godz. i 3 dni, cel i stop w tych samych % co w aplikacji), ale tylko coiny, które OKX Europe ma w ofercie X-Perps, i po cenach OKX. Scenariusze z OKX wchodzą zleceniem z limitem po cenie z aplikacji, pozostałe od razu po cenie OKX. Ryzyko 1% na pozycję, maks. 10 pozycji. Start 27.11.2026.', riskPct: 0.01, maxOpen: 10, maxOpenRisk: 0.10, dailyLossPct: 0.06, copy: true, venue: 'okx' },
  K: { name: 'Kopia aplikacji – tylko Kraken', desc: 'Jak O, ale tylko coiny z kontraktami perpetual na Krakenie (Kraken Pro, licencja MiFID w UE) i po cenach Krakena. Wszystkie scenariusze wchodzą od razu po cenie Krakena, z celem i stopem w tych samych % co w aplikacji. Ryzyko 1% na pozycję, maks. 10 pozycji. Start 27.11.2026.', riskPct: 0.01, maxOpen: 10, maxOpenRisk: 0.10, dailyLossPct: 0.06, copy: true, venue: 'kraken' },
  G: { name: 'Wskaźniki + filtr modelu', desc: 'Gra z trendem na wykresie godzinowym: trend (EMA20 i EMA50), RSI, wolumen i zmienność (ATR). W trendzie spadkowym czeka na odbicie do EMA20 na słabym wolumenie i wchodzi w shorta, gdy odbicie gaśnie (świeca zamyka się z powrotem pod EMA20, RSI zawraca w dół). W trendzie wzrostowym odwrotnie – long po korekcie. Wchodzi tylko wtedy, gdy model w układzie 2:1 daje w tym kierunku co najmniej 38% (próg opłacalności to ok. 33%). Stop za szczytem (dołkiem) odbicia, cel 2× dalej, po dojściu do celu ciągnie zysk. Eksperyment: tej reguły nie testowaliśmy na historii – wynik na żywo jest testem.', maxOpen: 6, ind: true },
};
// konto F: maks. pogorszenie ceny względem aplikacji i czas ważności zlecenia z limitem
const COPY = { limitMs: 36e5 };
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
        let ns = L ? p.best - p.rDist : p.best + p.rDist;
        // konto I: po celu co najmniej połowa drogi do celu zostaje zabezpieczona
        if (p.lockHalf) ns = L ? Math.max(ns, p.entry + (p.lockHalf - p.entry) * 0.5) : Math.min(ns, p.entry - (p.entry - p.lockHalf) * 0.5);
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

// ---------- konto G: wskaźniki (bez modelu) ----------
const emaArr = (x, n) => { const a = 2 / (n + 1), o = [x[0]]; for (let i = 1; i < x.length; i++) o.push(o[i - 1] + a * (x[i] - o[i - 1])); return o; };
function rsiArr(c, n = 14) {
  const o = new Array(c.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
// sygnał na ZAMKNIĘTYCH świecach 1h (k = { t,o,h,l,c,v }); zwraca { side, stopPct, price, why } albo null
function indSignal(k, now) {
  const n = k.c.length; if (n < 60) return null;
  let m = n; while (m > 0 && k.t[m - 1] + H1 > now) m--; // tylko zamknięte
  if (m < 60 || now - (k.t[m - 1] + H1) > H1) return null; // ostatnia zamknięta świeca musi być świeża
  const c = k.c.slice(0, m), h = k.h.slice(0, m), l = k.l.slice(0, m), o = k.o.slice(0, m), v = k.v.slice(0, m);
  const e20 = emaArr(c, 20), e50 = emaArr(c, 50), rsi = rsiArr(c), i = m - 1;
  let atr = 0; for (let j = i - 13; j <= i; j++) atr += Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1])) / 14;
  const W = 6, from = i - W + 1;
  const volBounce = v.slice(from, i + 1).reduce((a, x) => a + x, 0) / W, volBase = v.slice(i - 26, from).reduce((a, x) => a + x, 0) / 20;
  const down = [...Array(10).keys()].every(d => e20[i - d] < e50[i - d]) && e50[i] < e50[i - 10] && c[i] < e50[i];
  const up = [...Array(10).keys()].every(d => e20[i - d] > e50[i - d]) && e50[i] > e50[i - 10] && c[i] > e50[i];
  const hiW = Math.max(...h.slice(from, i + 1)), loW = Math.min(...l.slice(from, i + 1));
  const rsiMax = Math.max(...rsi.slice(from, i + 1)), rsiMin = Math.min(...rsi.slice(from, i + 1));
  let side = null, stop = 0;
  // short: odbicie do EMA20 (RSI ≥ 50) na słabym wolumenie, ostatnia świeca spadkowa zamyka się pod EMA20, RSI zawraca w dół
  if (down && hiW >= e20[i] && rsiMax >= 50 && c[i] < e20[i] && c[i] < o[i] && rsi[i] < rsi[i - 1] && rsi[i] > 30 && volBounce < volBase) { side = 'SHORT'; stop = hiW + 0.3 * atr; }
  if (up && loW <= e20[i] && rsiMin <= 50 && c[i] > e20[i] && c[i] > o[i] && rsi[i] > rsi[i - 1] && rsi[i] < 70 && volBounce < volBase) { side = 'LONG'; stop = loW - 0.3 * atr; }
  if (!side) return null;
  const stopPct = Math.abs(stop / c[i] - 1) * 100;
  if (stopPct < 1.3 || stopPct > 8) return null;
  return { side, stopPct, price: c[i], t: k.t[i], why: `trend ${side === 'SHORT' ? 'spadkowy' : 'wzrostowy'}, RSI ${rsi[i].toFixed(0)}, wolumen odbicia ${(volBounce / volBase * 100).toFixed(0)}% średniej` };
}
// 21.11.2026: próg obniżony z 45% do 38% – przy 45% przez ~34 godz. sito przechodził 1 coin z ~250 (zero wejść)
const G_MIN_P = 0.38;
const G_P = (co, side) => { const b = co.res && co.res['1h'] && co.res['1h'].big, x = b && b[side === 'LONG' ? 'long' : 'short']; return x && x.p > 0 ? x.p : 0; };
// kandydaci G: wstępne sito z wyników skanu (EMA20/EMA50 i cena), potem świece 1h z BingX dla najmocniejszych trendów
async function indCandidates(res, byBase, now) {
  if (!res.klines1h) return [];
  const seen = new Set();
  // wszystkie giełdy, jeśli coin jest na BingX (np. DODO z Binance); każdy coin raz, pierwszeństwo BingX
  const pre = [...res.coins].sort((a, b) => (b.ex === 'bingx') - (a.ex === 'bingx')).filter(co => !seen.has(E.cleanBase(co.base)) && seen.add(E.cleanBase(co.base)) && co.res && co.res['1h'] && co.res['1h'].ma && byBase.has(E.cleanBase(co.base)))
    .map(co => { const ma = co.res['1h'].ma, pr = co.res['1h'].price; return { co, s: ma.ema50 > 0 ? (ma.ema20 / ma.ema50 - 1) : 0, pr, ma }; })
    .filter(x => (x.s < 0 && x.pr < x.ma.ema50) || (x.s > 0 && x.pr > x.ma.ema50))
    // model w układzie 2:1 musi dawać ≥ G_MIN_P (38%) w kierunku trendu (próg opłacalności ok. 33%) – od 20.11.2026, obniżone 21.11
    .filter(x => G_P(x.co, x.s < 0 ? 'SHORT' : 'LONG') >= G_MIN_P)
    .sort((a, b) => Math.abs(b.s) - Math.abs(a.s)).slice(0, 30);
  const out = [];
  for (const x of pre) {
    let k = null; try { k = await res.klines1h(byBase.get(E.cleanBase(x.co.base)).sym); } catch (e) { }
    const sg = k && indSignal(k, now); if (!sg) continue;
    const p = G_P(x.co, sg.side); if (p < G_MIN_P) continue;
    out.push({ coin: x.co, iv: '1h', side: sg.side, p, mode: 'ind', lift: Math.abs(x.s), movePct: sg.stopPct * 2, stopPct: sg.stopPct, ev: 0, signalPrice: sg.price, tickerPrice: sg.price, why: sg.why + `, model 2:1: ${(p * 100).toFixed(0)}%` });
  }
  return out;
}

// ---------- konto F: kopia aplikacji ----------
// nowe zielone scenariusze z historii aplikacji (zapisane po ostatnim uruchomieniu konta)
function copyCandidates(st, hist, now) {
  const since = st.lastPickT || now - 30 * 6e4;
  return (hist || []).filter(p => p.method === 2 && p.status === 'open' && p.t > since && p.t <= now && p.end > now
    && (p.iv === '1h' || p.iv === '4h') // 14 dni wyłączone na prośbę (20.11.2026)
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
const DIR_PER_HOUR = 2; // ograniczenie korelacji: maks. 2 nowe pozycje w tym samym kierunku w ciągu godziny (konta F, H, I)
function copyOpen(st, o, entry, t, byBase, key) {
  const A = ACCOUNTS[key], riskPct = A.riskPct || BASE.riskPct, L = o.side === 'LONG';
  const sameDir = [...st.positions, ...st.closed.slice(-30)].filter(p => p.side === o.side && Math.abs(t - p.openedAt) < 36e5).length;
  if (sameDir >= DIR_PER_HOUR) return `już ${sameDir} nowe pozycje ${L ? 'LONG' : 'SHORT'} w tej godzinie (limit korelacji)`;
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
  const ext = A.trail && o.pickT ? Math.max(0, o.end - o.pickT) : A.trader ? TR.H : 0;
  const pos = { id: `${t}-${o.sym}`, base: o.base, sym: o.sym, side: o.side, iv: o.iv, mode: o.mode || (A.trail ? 'copytrail' : 'copy'), openedAt: t, end: o.end + ext,
    ...(A.trail ? { trail: true, rDist: dist, best: entry } : {}),
    ...(A.trader ? { trail: true, rDist: dist, best: entry, lockHalf: o.target } : {}),
    entry, qty, target: o.target, stop: o.stop, p: o.p || 0, ev: 0, lift: o.lift || 0, costR: +(costPerUnit(entry) / dist).toFixed(3),
    checkedTo: t, method: BASE.method, appPrice: o.limit, pickId: o.pickId, fillType: o.fillType || 'limit', spreadPct: o.spreadPct ?? null };
  pos.risk = openRisk(pos);
  st.positions.push(pos);
  st.log.unshift(`${stamp(t)} otwarto ${o.base} ${o.side} (${IV_LABEL[o.iv] || o.iv}, ${o.label || (A.trail ? 'kopia + ciągnięcie zysku' : 'kopia aplikacji 2:1')}) po ${entry.toPrecision(5)}${pos.fillType === 'limit' ? ' (zlecenie z limitem)' : ''}${o.why ? ' – ' + o.why : ''}`);
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
      else if (COPY_CHART[key]) await copyChart(key, o, 'WEJŚCIE – zlecenie z limitem wykonane', { entry: f.px, entryLabel: 'wejście', checks: `scenariusz z aplikacji · ${IV_LABEL[o.iv] || o.iv} · układ 2:1` });
      st.pending = st.pending.filter(x => x !== o);
    } else if (now >= o.expires) {
      st.log.unshift(`${stamp(now)} zlecenie z limitem ${o.base} ${o.side} po ${o.limit.toPrecision(5)} wygasło – cena nie wróciła`);
      st.pending = st.pending.filter(x => x !== o);
    }
  }
}
// Poziom przy celu: dołki (szczyty) lokalne z ±2 świec w ostatnich 48 zamkniętych świecach 1h; ≥ 2 w odległości ≤ 0,25 ATR = wsparcie (opór).
// Zwraca poziom, jeśli leży ±0,5 ATR od celu (np. short z celem na podwójnym dołku), inaczej null. Ta sama zasada co levelAt w scripts/backtest-top.js.
function levelNearTarget(k, now, long, target) {
  if (!k || !k.t) return null;
  let idx = k.t.length - 1; while (idx >= 0 && k.t[idx] + 36e5 > now) idx--;
  if (idx < 52) return null;
  let atr = 0; for (let i = idx - 13; i <= idx; i++) atr += Math.max(k.h[i] - k.l[i], Math.abs(k.h[i] - k.c[i - 1]), Math.abs(k.l[i] - k.c[i - 1])); atr /= 14;
  if (!(atr > 0)) return null;
  const pts = [];
  for (let m = idx - 48; m <= idx - 2; m++) {
    let ok = true; for (let x = m - 2; x <= m + 2; x++) if (x !== m && (long ? k.h[x] > k.h[m] : k.l[x] < k.l[m])) { ok = false; break; }
    if (ok) pts.push(long ? k.h[m] : k.l[m]);
  }
  for (const a of pts) { const g = pts.filter(b => Math.abs(b - a) <= 0.25 * atr); if (g.length < 2) continue;
    const lv = g.reduce((q, b) => q + b, 0) / g.length; if (Math.abs(lv - target) <= 0.5 * atr) return lv; }
  return null;
}
// 3. nowe wejścia F
async function copyEntries(key, st, hist, byBase, now, skip) {
  st.pending = st.pending || [];
  const picks = copyCandidates(st, hist, now);
  st.lastPickT = Math.max(st.lastPickT || now - 30 * 6e4, ...picks.map(p => p.t));
  let opened = 0;
  const pass = (p, why) => { skip(why); st.log.unshift(`${stamp(now)} pominięto ${p.base} ${p.dir} (${IV_LABEL[p.iv] || p.iv}): ${why}`); };
  for (const p of picks) {
    const live = byBase.get(E.cleanBase(p.base));
    const VN = ACCOUNTS[key].venue ? VENUES[ACCOUNTS[key].venue].name : 'BingX';
    if (!live || !(live.price > 0)) { pass(p, 'brak coina na ' + VN); continue; }
    if (st.positions.length + st.pending.length >= ACCOUNTS[key].maxOpen) { pass(p, 'maks. liczba pozycji'); continue; }
    const cb = E.cleanBase(p.base);
    if (st.positions.some(x => E.cleanBase(x.base) === cb) || st.pending.some(x => E.cleanBase(x.base) === cb)) { pass(p, 'już ma otwartą pozycję na tym coinie'); continue; }
    const L = p.dir === 'LONG';
    if (ACCOUNTS[key].lvlFilter && p.iv === '1h' && CHART_RES && CHART_RES.klines1h) {
      let k = null; try { k = await CHART_RES.klines1h(live.sym); } catch (e) { }
      const tg = p.ex !== 'bingx' ? p.target * live.price / p.price : p.target;
      const lv = levelNearTarget(k, now, L, tg);
      if (lv !== null) { pass(p, `cel przy ${L ? 'oporze' : 'wsparciu'} ${lv.toPrecision(5)} przetestowanym 2× (${L ? 'podwójny szczyt' : 'podwójny dołek'})`); continue; }
    }
    const base = { id: `${now}-${live.sym}`, pickId: p.id, pickT: p.t, base: p.base, sym: live.sym, side: p.dir, iv: p.iv, end: p.end, placedAt: now, expires: now + COPY.limitMs, p: p.p, lift: p.lift,
      spreadPct: live.bid > 0 && live.ask > 0 ? +((live.ask - live.bid) / live.price * 100).toFixed(3) : null };
    if (p.ex !== (ACCOUNTS[key].venue || 'bingx')) {
      // scenariusz z innej giełdy (Binance/OKX): ceny różnią się między giełdami, więc wejście po cenie BingX,
      // a cel i stop w tych samych procentach co w aplikacji
      const k = live.price / p.price, px = fill(live.price, p.dir, true);
      const o = { ...base, limit: live.price, target: p.target * k, stop: p.stop * k, fillType: 'od razu (scenariusz z ' + ({ okx: 'OKX', bingx: 'BingX' }[p.ex] || 'Binance') + ', ceny z ' + VN + ')' };
      const r = copyOpen(st, o, px, now, byBase, key);
      if (typeof r === 'string') pass(p, r); else { opened++; if (COPY_CHART[key]) await copyChart(key, o, 'WEJŚCIE – po cenie ' + VN, { entry: px, entryLabel: 'wejście', checks: `scenariusz z aplikacji (${({ okx: 'OKX', bingx: 'BingX' })[p.ex] || 'Binance'}) · ${IV_LABEL[o.iv] || o.iv} · cel i stop w tych samych %` }); }
      continue;
    }
    // scenariusz z BingX: zlecenie z limitem dokładnie po cenie z aplikacji
    const o = { ...base, limit: p.price, target: p.target, stop: p.stop };
    if (L ? live.price >= p.target : live.price <= p.target) { pass(p, 'cena już doszła do celu'); continue; }
    if (L ? live.price <= p.stop : live.price >= p.stop) { pass(p, 'cena już za stopem'); continue; }
    const worse = L ? live.price / p.price - 1 : 1 - live.price / p.price;
    if (worse <= 0) {
      const px = L ? Math.min(fill(live.price, 'LONG', true), p.price) : Math.max(fill(live.price, 'SHORT', true), p.price);
      const r = copyOpen(st, { ...o, fillType: 'od razu' }, px, now, byBase, key);
      if (typeof r === 'string') pass(p, r); else { opened++; if (COPY_CHART[key]) await copyChart(key, o, 'WEJŚCIE – po cenie z aplikacji', { entry: px, entryLabel: 'wejście', checks: `scenariusz z aplikacji · ${IV_LABEL[o.iv] || o.iv} · układ 2:1` }); }
    } else {
      // cena uciekła: zlecenie czeka godzinę na powrót do ceny z aplikacji (nie wchodzi drożej)
      st.pending.push(o);
      if (COPY_CHART[key]) await copyChart(key, o, 'zlecenie z limitem – czeka na cenę z aplikacji', { entry: o.limit, entryLabel: 'limit', checks: `cena teraz ${live.price.toPrecision(5)} · zlecenie ważne 1 godz. · ${IV_LABEL[o.iv] || o.iv}` });
      st.log.unshift(`${stamp(now)} zlecenie z limitem ${p.base} ${p.dir} po ${p.price.toPrecision(5)} (cena teraz ${live.price.toPrecision(5)}, ${IV_LABEL[p.iv] || p.iv})`);
      skip('czeka zlecenie z limitem');
    }
  }
  return opened;
}

// ---------- konto I: trader – model podsuwa, bot sam potwierdza ----------
var TR = { lift: 0.05, top: 20, minScore: 2, watchMs: 3 * 36e5, H: 24 * 36e5, minRR: 1.2 };
const rrAt = (w, e) => Math.abs(w.target - e) / Math.abs(e - w.stop);
// kandydaci: 24 godz., układ 2:1, p > próg + 2 pkt, skill ≥ 1%, przewaga ≥ 5 pkt, stop ≥ 1,3%, bez ostrzeżeń
function traderCandidates(res, now) {
  const out = [];
  for (const co of res.coins || []) {
    const a = co.res && co.res['1h']; if (!a || a.error || a.regime || !a.big) continue;
    if ((E.isExtreme && E.isExtreme(co)) || (E.isIlliquid && E.isIlliquid(co))) continue;
    let best = null;
    for (const side of ['long', 'short']) {
      const d = E.dirOf(a, 'big', side); if (!d || d.p === null || d.weak || d.tooWide) continue;
      const lift = d.p - d.hist;
      if (!(d.p > 1 / 3 + 0.02 && (d.skill || 0) >= 0.01 && lift >= TR.lift && Math.abs(d.stopPct) >= E.MIN_STOP_PCT)) continue;
      if (!best || lift > best.lift) best = { co, a, d, lift };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => y.lift - x.lift).slice(0, TR.top);
}
// punkty potwierdzenia na ostatniej ZAMKNIĘTEJ świecy 1h (q); k4 – świece 4h do trendu
function traderScore(k, k4, q, long) {
  const c = k.c, a = 2 / 21, ema = [c[0]], rsi = new Array(c.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) { ema.push(ema[i - 1] + a * (c[i] - ema[i - 1])); const d = c[i] - c[i - 1], u = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= 14) { g += u / 14; l += dn / 14; } else { g = (g * 13 + u) / 14; l = (l * 13 + dn) / 14; } if (i >= 14) rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  const recent = long ? Math.min(k.l[q], k.l[q - 1]) : Math.max(k.h[q], k.h[q - 1]); let ext = recent;
  for (let m = q - 23; m <= q - 2; m++) if (m >= 0) ext = long ? Math.min(ext, k.l[m]) : Math.max(ext, k.h[m]);
  let vav = 0; for (let m = q - 19; m <= q; m++) vav += (k.v[Math.max(0, m)] || 0) / 20;
  let t4ok = false, t4 = null;
  if (k4 && k4.c.length > 25) { const e4 = [k4.c[0]]; for (let i = 1; i < k4.c.length; i++) e4.push(e4[i - 1] + a * (k4.c[i] - e4[i - 1])); const j = e4.length - 1; t4 = e4[j] - e4[j - 3]; t4ok = long ? t4 >= 0 : t4 <= 0; }
  const ch = {
    'nie nóż': long ? recent > ext : recent < ext,
    [`RSI ${rsi[q].toFixed(0)}`]: long ? rsi[q] >= 40 && rsi[q] <= 75 && rsi[q] > rsi[q - 2] : rsi[q] <= 60 && rsi[q] >= 25 && rsi[q] < rsi[q - 2],
    'EMA20': long ? c[q] > ema[q] : c[q] < ema[q],
    [`wolumen ${vav > 0 ? (k.v[q] / vav).toFixed(1) : '?'}×`]: vav > 0 && k.v[q] >= vav,
    'trend 4h': t4ok,
  };
  const sc = Object.values(ch).filter(Boolean).length;
  return { sc, txt: Object.entries(ch).map(([n, v]) => `${n} ${v ? '✓' : '✗'}`).join(', ') };
}
// wykresy na Telegram (konto I): zbierane w trakcie przebiegu, wysyłane po zapisie stanu
const PHOTOS = [];
let CHART_RES = null; // wyniki skanu (świece) dla wykresów konta F
async function queueChart(res, w, status, extra = {}) {
  if (!process.env.TELEGRAM_TOKEN || PHOTOS.length >= 10) return;
  // to samo wejście kilku kont (F i H z tego samego scenariusza) = jeden wykres z dopiskiem obu kont
  if (w.pickId) {
    const same = PHOTOS.find(ph => ph.pickId === w.pickId && ph.o.status === status);
    if (same) { if (!same.accts.includes(w.acctKey)) { same.accts.push(w.acctKey); same.o.sub = same.o.sub.replace(/konto .*$/, `konto ${same.accts.join(' + ')} (to samo wejście)`); } return; }
  }
  try { const k = w.venue ? await VENUES[w.venue].klines(w.sym, '1h', 120) : await res.klines1h(w.sym); if (k) PHOTOS.push({ k, pickId: w.pickId || null, accts: [w.acctKey || 'I'], o: { base: w.base, side: w.side, status, lvl: w.lvl, stop: w.stop, target: w.target, sub: `model ${((w.p || 0) * 100).toFixed(0)}% · przewaga +${((w.lift || 0) * 100).toFixed(0)} pkt · konto ${w.acct || 'I (trader)'}`, checks: (w.scoreTxt || w.lastTxt || '').replace(/, /g, '  '), venueName: w.venue ? VENUES[w.venue].name : 'BingX', ...extra } }); } catch (e) { }
}
const COPY_CHART = { F: 'F (kopia aplikacji)', H: 'H (kopia + ciągnięcie zysku)', O: 'O (OKX Europe)', K: 'K (Kraken)' };
async function copyChart(key, o, status, extra) {
  if (!COPY_CHART[key] || !CHART_RES) return;
  await queueChart(CHART_RES, { ...o, acct: COPY_CHART[key], acctKey: key, venue: ACCOUNTS[key].venue || null }, status, extra);
}
const closedIdx = (k, now) => { let q = k.t.length - 1; while (q >= 0 && k.t[q] + 36e5 > now) q--; return q; };
// 0. obserwowane scenariusze: wybicie (zlecenie stop wykonane na 5m), stop przed wybiciem, uzbrajanie na kolejną godzinę
async function traderWatch(key, st, res, barsFor, byBase, now) {
  st.watch = st.watch || [];
  for (const w of [...st.watch]) {
    const L = w.side === 'LONG'; let done = null;
    const bars = (await barsFor(w.sym)) || [];
    for (const b of bars) {
      if (b.t + b.dur <= (w.checked || w.sigT) || b.t + b.dur > now) continue;
      // świeca, w której uzbrojono zlecenie, liczy się, jeśli w chwili uzbrojenia cena była jeszcze przed poziomem wybicia
      const armed = w.armedAt && b.t < w.armedUntil && (b.t >= w.armedAt || (b.t + b.dur > w.armedAt && w.armPrice && (L ? w.armPrice < w.lvl : w.armPrice > w.lvl)));
      if (armed && (L ? b.h >= w.lvl : b.l <= w.lvl)) {
        const fp = b.t >= w.armedAt ? (L ? Math.max(w.lvl, b.o) : Math.min(w.lvl, b.o)) : w.lvl;
        done = rrAt(w, fp) >= TR.minRR ? { fill: fp, t: Math.max(b.t, w.armedAt) + 1 } : { cancel: `cena przeskoczyła za daleko za poziom wybicia (zostało tylko ${rrAt(w, fp).toFixed(1)}R do celu)` }; break; }
      if (L ? b.l <= w.stop : b.h >= w.stop) { done = { cancel: 'cena dotknęła stopu przed wybiciem' }; break; }
      w.checked = b.t + b.dur;
    }
    if (done && done.fill) {
      const r = copyOpen(st, { ...w, mode: 'trader', label: 'trader + ciągnięcie zysku', fillType: 'wybicie', why: `wybicie ${w.lvl.toPrecision(5)} ✓, ${w.scoreTxt}`, limit: w.lvl }, done.fill, done.t, byBase, key);
      if (typeof r !== 'string') await queueChart(res, w, 'WEJŚCIE – wybicie potwierdzone', { entry: done.fill });
      if (typeof r === 'string') st.log.unshift(`${stamp(now)} pominięto ${w.base} ${w.side} (trader): ${r}`);
      st.watch = st.watch.filter(x => x !== w); continue;
    }
    if (done && done.cancel) { st.log.unshift(`${stamp(now)} pominięto ${w.base} ${w.side} (trader): ${done.cancel}`); st.watch = st.watch.filter(x => x !== w); continue; }
    if (now >= w.expires) { st.log.unshift(`${stamp(now)} pominięto ${w.base} ${w.side} (trader): brak potwierdzenia w 3 godz.${w.lastTxt ? ' (ostatnio: ' + w.lastTxt + ')' : ''}`); st.watch = st.watch.filter(x => x !== w); continue; }
    // uzbrojenie na następną godzinę wg ostatniej zamkniętej świecy
    let k = null, k4 = null; try { k = await res.klines1h(w.sym); k4 = res.klines4h ? await res.klines4h(w.sym) : null; } catch (e) { }
    if (!k) continue;
    const q = closedIdx(k, now); if (q < 25) continue;
    const s = traderScore(k, k4, q, L); w.lastTxt = `${s.sc}/5: ${s.txt}`;
    if (s.sc >= TR.minScore) {
      const live = byBase.get(E.cleanBase(w.base));
      // wybicie już nastąpiło (cena za poziomem w chwili oceny) → wejście od razu po cenie rynkowej, o ile zostaje ≥ 1,2R do celu
      if (live && live.price > 0 && (L ? live.price >= w.lvl : live.price <= w.lvl)) {
        const fp = fill(live.price, w.side, true); w.scoreTxt = `${s.sc}/5: ${s.txt}`;
        if (rrAt(w, fp) >= TR.minRR) { const r = copyOpen(st, { ...w, mode: 'trader', label: 'trader + ciągnięcie zysku', fillType: 'wybicie', why: `wybicie ${w.lvl.toPrecision(5)} ✓ (już nastąpiło), ${w.scoreTxt}`, limit: w.lvl }, fp, now, byBase, key);
          if (typeof r === 'string') st.log.unshift(`${stamp(now)} pominięto ${w.base} ${w.side} (trader): ${r}`);
          else await queueChart(res, w, 'WEJŚCIE – wybicie już nastąpiło', { entry: fp }); }
        else st.log.unshift(`${stamp(now)} pominięto ${w.base} ${w.side} (trader): cena już za daleko za poziomem wybicia (zostało tylko ${rrAt(w, fp).toFixed(1)}R do celu)`);
        st.watch = st.watch.filter(x => x !== w); continue;
      }
      const was = !!(w.armedUntil && w.armedUntil > now - 6e4); w.armedAt = now; w.armedUntil = Math.min(w.expires, now + 36e5); w.scoreTxt = `${s.sc}/5: ${s.txt}`; w.armPrice = live ? live.price : null;
      if (!was) { st.log.unshift(`${stamp(now)} czeka na wybicie ${w.base} ${w.side} ${L ? 'powyżej' : 'poniżej'} ${w.lvl.toPrecision(5)} (${w.scoreTxt})`); await queueChart(res, w, 'czeka na wybicie'); } }
    else { w.armedAt = null; w.armedUntil = null; }
  }
}
// 0c. konto I (wejście od razu): w ciągu 3 godz. wybicie szczytu/dołka 2 świec przy ≥ 2/5 punktów = pozycja zostaje,
// brak potwierdzenia = stop na cenę wejścia
async function traderConfirm(key, st, res, barsFor, now) {
  for (const p of st.positions) {
    if (!p.confirm) continue;
    const L = p.side === 'LONG', c = p.confirm; let ok = null;
    const bars = (await barsFor(p.sym)) || [];
    let k = null, k4 = null; try { k = await res.klines1h(p.sym); k4 = res.klines4h ? await res.klines4h(p.sym) : null; } catch (e) { }
    for (const b of bars) {
      if (b.t < c.sigT || b.t + b.dur > Math.min(now, c.until) || b.t + b.dur <= (c.checked || 0)) continue;
      c.checked = b.t + b.dur;
      if (!(L ? b.h >= c.lvl : b.l <= c.lvl) || !k) continue;
      let q = k.t.length - 1; while (q >= 0 && k.t[q] + 36e5 > b.t) q--;
      if (q < 25) continue;
      const s = traderScore(k, k4, q, L);
      if (s.sc >= TR.minScore) { ok = `${s.sc}/5: ${s.txt}`; break; }
      c.lastTxt = `${s.sc}/5: ${s.txt}`;
    }
    if (ok) { delete p.confirm; p.confirmed = true; st.log.unshift(`${stamp(now)} potwierdzone ${p.base} ${p.side} (trader): wybicie ${c.lvl.toPrecision(5)} ✓, ${ok} – pozycja zostaje`); continue; }
    if (now >= c.until) {
      delete p.confirm;
      const ns = L ? Math.max(p.stop, p.entry) : Math.min(p.stop, p.entry);
      if (ns !== p.stop) { p.stop = ns; p.risk = openRisk(p); }
      st.log.unshift(`${stamp(now)} brak potwierdzenia ${p.base} ${p.side} (trader) w 3 godz.${c.lastTxt ? ' (ostatnio: ' + c.lastTxt + ')' : ''} – stop przesunięty na wejście ${p.entry.toPrecision(5)}`);
    }
  }
}
// 3. nowe scenariusze do obserwacji
async function traderEntries(key, st, res, byBase, now, skip) {
  st.watch = st.watch || []; st.seen = st.seen || {};
  for (const [kk, until] of Object.entries(st.seen)) if (until <= now) delete st.seen[kk];
  let added = 0;
  for (const x of traderCandidates(res, now)) {
    const cb = E.cleanBase(x.co.base), live = byBase.get(cb), L = x.d.dir === 'LONG', key2 = cb + x.d.dir;
    if (st.seen[key2]) continue;
    st.seen[key2] = now + TR.H;
    if (!live || !(live.price > 0)) { skip('brak coina na BingX'); continue; }
    if (st.positions.some(p => E.cleanBase(p.base) === cb) || st.watch.some(w => E.cleanBase(w.base) === cb)) { skip('już ma pozycję lub obserwuje ten coin'); continue; }
    if (st.positions.length >= ACCOUNTS[key].maxOpen) { skip('maks. liczba pozycji'); continue; }
    let k = null; try { k = await res.klines1h(live.sym); } catch (e) { }
    if (!k) { skip('brak świec'); continue; }
    const q = closedIdx(k, now); if (q < 25) { skip('za mało świec'); continue; }
    const kx = live.price / x.a.price; // poziomy scenariusza w procentach, przeniesione na cenę BingX
    const w = { base: x.co.base, sym: live.sym, side: x.d.dir, iv: '1h', sigT: now, expires: now + TR.watchMs, end: now + TR.H,
      lvl: L ? Math.max(k.h[q], k.h[q - 1]) : Math.min(k.l[q], k.l[q - 1]), stop: x.d.stop * kx, target: x.d.target * kx, p: x.d.p, lift: x.lift, src: x.co.ex };
    if (L ? !(w.stop < live.price && w.lvl < w.target) : !(w.stop > live.price && w.lvl > w.target)) { skip('poziomy poza zakresem'); continue; }
    // wejście na poziomie wybicia musi dawać sensowny układ (≥ 1,2 : 1), inaczej szkoda obserwować
    if (!ACCOUNTS[key].early && rrAt(w, w.lvl) < TR.minRR) { skip('poziom wybicia za blisko celu'); st.log.unshift(`${stamp(now)} pominięto ${w.base} ${w.side} (trader): poziom wybicia ${w.lvl.toPrecision(5)} za blisko celu – zysk : ryzyko tylko ${rrAt(w, w.lvl).toFixed(1)} : 1`); continue; }
    if (ACCOUNTS[key].early) {
      const fp = fill(live.price, w.side, true);
      const r = copyOpen(st, { ...w, mode: 'trader', label: 'trader: wejście od razu', fillType: 'od razu', why: `model ${(x.d.p * 100).toFixed(0)}%, przewaga +${(x.lift * 100).toFixed(0)} pkt · potwierdzenie (wybicie ${w.lvl.toPrecision(5)} i ≥ 2/5) w ciągu 3 godz., inaczej stop na wejście`, limit: live.price }, fp, now, byBase, key);
      if (typeof r === 'string') { skip(r); st.log.unshift(`${stamp(now)} pominięto ${w.base} ${w.side} (trader): ${r}`); continue; }
      r.confirm = { lvl: w.lvl, sigT: now, until: now + TR.watchMs };
      added++; await queueChart(res, { ...w, acct: 'I (trader)', acctKey: 'I' }, 'WEJŚCIE od razu – czeka na potwierdzenie 3 godz.', { entry: fp }); continue;
    }
    st.watch.push(w); added++;
    st.log.unshift(`${stamp(now)} obserwuje ${w.base} ${w.side} (model ${(x.d.p * 100).toFixed(0)}%, przewaga +${(x.lift * 100).toFixed(0)} pkt) – czeka na potwierdzenie do 3 godz.`);
  }
  // od razu ocena i uzbrojenie świeżo dodanych (pierwsza godzina obserwacji)
  return added;
}

async function runAccount(key, st, res, byBase, barsFor, now) {
  const riskPct = ACCOUNTS[key].riskPct || BASE.riskPct, maxOpen = ACCOUNTS[key].maxOpen || BASE.maxOpen;
  // 0. dzień (czas polski) – baza dnia = equity PRZED rozliczeniem tego skanu
  const today = dayKey(now);
  if (!st.day || st.day.date !== today) st.day = { date: today, startEquity: +(st.balance + unrealized(st, byBase)).toFixed(4), halted: false };
  if (st.day.startEquity === undefined) st.day.startEquity = st.day.startBalance || st.balance; // stary format
  // 0b. konto F: wykonanie / wygaśnięcie zleceń z limitem (przed rozliczeniem – nowa pozycja rozlicza się od świecy wejścia)
  if (ACCOUNTS[key].copy) { CHART_RES = res; await copyFills(key, st, barsFor, byBase, now); }
  if (ACCOUNTS[key].trader && ACCOUNTS[key].early) await traderConfirm(key, st, res, barsFor, now);
  else if (ACCOUNTS[key].trader) await traderWatch(key, st, res, barsFor, byBase, now);
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
  const dlp = ACCOUNTS[key].dailyLossPct || BASE.dailyLossPct;
  if (!st.day.halted && (st.day.startEquity - equity) / st.day.startEquity >= dlp) {
    st.day.halted = true; st.log.unshift(`${stamp(now)} dzienny limit straty (−${(dlp * 100).toFixed(0)}% equity) – brak nowych wejść do końca dnia`);
  }
  // 2b. tryb obserwacji – pogorszenie wyników
  const obs = observeCheck(st, equity);
  if (obs && !st.observe) { st.observe = { since: now, reason: obs }; st.log.unshift(`${stamp(now)} TRYB OBSERWACJI: ${obs} – brak nowych wejść do ręcznego wznowienia`); }
  if (st.observe && process.env.BOT_RESUME === '1') { st.log.unshift(`${stamp(now)} wznowiono handel (ręcznie)`); st.observe = null; st.peakEquity = equity; }
  // 3. wejścia (z zapisem powodów odrzucenia)
  let opened = 0; const resAge = now - Date.parse(res.generatedAt || 0); const rej = {};
  const skip = r => { rej[r] = (rej[r] || 0) + 1; };
  if (st.day.halted) {
    skip('dzienny limit straty');
    // konta-kopie: scenariusze z czasu blokady oznaczamy jako pominięte, żeby następnego dnia nie wchodzić w stare
    if (ACCOUNTS[key].copy) for (const p of copyCandidates(st, res.history, now)) { st.lastPickT = Math.max(st.lastPickT || 0, p.t); st.log.unshift(`${stamp(now)} pominięto ${p.base} ${p.dir} (${IV_LABEL[p.iv] || p.iv}): dzienny limit straty`); }
  }
  else if (st.observe) skip('tryb obserwacji');
  else if (ACCOUNTS[key].copy) { CHART_RES = res; opened = await copyEntries(key, st, res.history, byBase, now, skip); }
  else if (ACCOUNTS[key].trader && ACCOUNTS[key].early) await traderEntries(key, st, res, byBase, now, skip);
  else if (ACCOUNTS[key].trader) { await traderEntries(key, st, res, byBase, now, skip); await traderWatch(key, st, res, async () => [], byBase, now); }
  else {
    const list = ACCOUNTS[key].ind ? await indCandidates(res, byBase, now) : candidates(key, res);
    for (const c of list) {
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
      const trail = key === 'D' || (key === 'E' && c.mode === 'big') || c.mode === 'ind';
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
      st.log.unshift(`${stamp(now)} otwarto ${c.coin.base} ${c.side} (${c.iv === '1h' ? '24 godz.' : c.iv === '1d' ? 'do 42 dni' : '3 dni'}, ${c.mode === 'trend' ? 'z trendem: ' + ((c.trendSig && c.trendSig.kind) || 'dzienne') : c.mode === 'ind' ? 'wskaźniki 2:1' : c.mode === 'big' ? '2:1' : c.mode === 'safe' ? '1:2' : '1:1'}) po ${entry.toPrecision(5)}${c.why ? ' – ' + c.why : ''}`);
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
  for (const key of Object.keys(ACCOUNTS)) {
    let old = prev && prev.accounts && prev.accounts[key] ? prev.accounts[key] : null;
    // reset pojedynczego konta (nowa zasada): poprzedni okres do archiwum, konto od nowa z 1000 USDT
    if (old && ACCOUNTS[key].resetTag && old.acctReset !== ACCOUNTS[key].resetTag) {
      state.archive.unshift({ tag: `${key}: ${old.acctReset || 'start'}`, until: now, accounts: { [key]: { name: old.name, startedAt: old.startedAt, balance: old.balance, closed: old.closed, openAtReset: old.positions,
        n: old.closed.length, wins: old.closed.filter(p => p.net > 0).length, net: +old.closed.reduce((x, p) => x + p.net, 0).toFixed(2) } } });
      console.log(`Bot: reset konta ${key} (${ACCOUNTS[key].resetTag}) – poprzedni okres w archiwum`);
      old = null;
    }
    state.accounts[key] = { ...(old || { ...fresh(now), acctReset: ACCOUNTS[key].resetTag }), ...ACCOUNTS[key] };
    if (!state.accounts[key].acctReset && ACCOUNTS[key].resetTag) state.accounts[key].acctReset = ACCOUNTS[key].resetTag;
  }

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

  // konto G: świece 1h z BingX (tylko dla wstępnie wybranych coinów)
  const k1Cache = new Map();
  res.klines1h = async sym => { if (!k1Cache.has(sym)) k1Cache.set(sym, await X.bingxKlines(sym, '1h', 120)); return k1Cache.get(sym); };
  const k4Cache = new Map();
  res.klines4h = async sym => { if (!k4Cache.has(sym)) k4Cache.set(sym, await X.bingxKlines(sym, '4h', 60)); return k4Cache.get(sym); };
  const logLen = Object.fromEntries(Object.keys(ACCOUNTS).map(k => [k, (state.accounts[k].log || []).length]));
  // konta O i K: ceny i świece z OKX / Krakena
  const VCTX = {};
  for (const v of new Set(Object.values(ACCOUNTS).map(a => a.venue).filter(Boolean))) {
    try {
      const tk = await VENUES[v].tickers(); if (!tk.length) throw new Error('pusta lista');
      const vc = new Map();
      VCTX[v] = { byBase: new Map(tk.map(t => [E.cleanBase(t.base), t])), barsFor: async sym => {
        if (!vc.has(sym)) { let k1 = null, k5 = null;
          try { k1 = await VENUES[v].klines(sym, '1h', 200); } catch (e) { }
          try { k5 = await VENUES[v].klines(sym, '5m', 288); } catch (e) { }
          vc.set(sym, mergeBars(k1, k5, now)); }
        return vc.get(sym); } };
    } catch (e) { console.log(`Ceny ${VENUES[v].name} niedostępne: ${e.message}`); }
  }
  for (const key of Object.keys(ACCOUNTS)) {
    const v = ACCOUNTS[key].venue;
    if (v && !VCTX[v]) { console.log(`Bot (na sucho) ${key}: pominięte – brak cen ${VENUES[v].name}`); continue; }
    const cx = v ? VCTX[v] : { byBase, barsFor };
    console.log('Bot (na sucho) ' + await runAccount(key, state.accounts[key], res, cx.byBase, cx.barsFor, now));
  }
  state.updatedAt = now;
  saveState(path.join(OUT_DIR, 'bot.json'), state);
  await sendTelegram(buildNotice(state, logLen, now));
  await sendCharts();
}
// podpis pod wykresem: poziom wybicia tylko dla konta I (konta-kopie F/H go nie mają)
function chartCaption(o) {
  const n = v => (v > 0 ? v.toPrecision(5) : null);
  const lv = [o.lvl > 0 ? `wybicie ${n(o.lvl)}` : null, o.entry > 0 ? `${o.entryLabel || 'wejście'} ${n(o.entry)}` : null,
    o.stop > 0 ? `stop ${n(o.stop)}` : null, o.target > 0 ? `cel ${n(o.target)}` : null].filter(Boolean).join(' · ');
  const acct = (o.sub || '').match(/konto (.*)$/);
  return [`📊 ${o.base} ${o.side} · ${o.status}`, acct ? `konto ${acct[1]}` : null, lv, o.checks || null].filter(Boolean).join('\n');
}
async function sendCharts() {
  const token = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || !PHOTOS.length) return;
  const { chartSVG, renderPng } = require('./chart.js');
  for (const ph of PHOTOS) {
    try {
      const png = renderPng(chartSVG(ph.k, ph.o)); if (!png) { console.log('Telegram: brak modułu do wykresów – pomijam zdjęcia'); return; }
      const fd = new FormData(); fd.append('chat_id', chat);
      fd.append('caption', chartCaption(ph.o));
      fd.append('photo', new Blob([png], { type: 'image/png' }), 'wykres.png');
      const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd });
      console.log('Telegram wykres:', r.ok ? 'wysłano' : 'błąd ' + r.status);
    } catch (e) { console.log('Telegram wykres: nie udało się'); }
  }
}

// ---------- powiadomienia na Telegram (tylko gdy coś się wydarzyło) ----------
// sekrety TELEGRAM_TOKEN i TELEGRAM_CHAT_ID ustawia właściciel w GitHubie; bez nich nic nie jest wysyłane
const NOTICE_ICON = l => / otwarto .* LONG/.test(l) ? '🟢' : / otwarto .* SHORT/.test(l) ? '🔴' : / zamknięto .* \+/.test(l) ? '✅' : / zamknięto /.test(l) ? '❌'
  : /zlecenie z limitem .* po .* \(cena teraz/.test(l) ? '⏳' : /wygasło|pominięte/.test(l) ? '⌛' : /pominięto/.test(l) ? '⚪' : /obserwuje|czeka na wybicie/.test(l) ? '👀' : '⚠️';
function buildNotice(state, logLen, now) {
  const out = [];
  for (const [k, a] of Object.entries(state.accounts)) {
    const fresh = (a.log || []).slice(0, Math.max(0, (a.log || []).length - (logLen[k] || 0))).reverse();
    for (const l of fresh) out.push(`${NOTICE_ICON(l)} ${k} · ${l.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d\s+/, '')}`);
  }
  if (!out.length) return null;
  const bal = Object.entries(state.accounts).map(([k, a]) => `${k} ${a.balance.toFixed(0)}`).join(' · ');
  const hhmm = new Date(now).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
  return `🤖 TradingJam bot (na sucho) · ${hhmm}\n\n${out.join('\n')}\n\nSalda: ${bal}`.slice(0, 4000);
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!text || !token || !chat) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
    console.log('Telegram:', r.ok ? 'wysłano' : 'błąd ' + r.status);
  } catch (e) { console.log('Telegram: nie udało się wysłać'); }
}

if (require.main === module) main().catch(e => { console.error('Bot – błąd:', e.message); process.exit(1); });
module.exports = { levelNearTarget, traderConfirm, ACCOUNTS, chartCaption, _queueChart: (...a) => queueChart(...a), _PHOTOS: PHOTOS, traderScore, traderCandidates, buildNotice, indSignal, limitFill, copyCandidates, observeCheck, settle, mergeBars, loadState, saveState, validateState, runAccount, rejectEntry, dayKey, openRisk, BASE, H_MS };
