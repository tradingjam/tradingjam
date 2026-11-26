// Testy regresyjne bota na sucho: rozliczanie pozycji, ryzyko, dzienny limit i stan.
// Uruchom: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../bot/paper.js');

const H = 36e5, M5 = 5 * 6e4;
const T0 = Date.UTC(2026, 10, 16, 10, 0); // 16.11.2026 10:00 UTC
const bar = (t, o, h, l, c, dur = H) => ({ t, dur, o, h, l, c });
const longPos = (over = {}) => ({ side: 'LONG', entry: 100, stop: 98, target: 104, qty: 1, openedAt: T0 + 30 * 6e4, end: T0 + 24 * H, checkedTo: T0 + 30 * 6e4, ...over });

test('wejście w środku świecy: cel w świecy wejścia nie jest zaliczany, stop tak', () => {
  // wejście 10:30, świeca 10:00–11:00 sięgnęła i 105 (cel), i 97 (stop) – nie wiemy kiedy
  const p = longPos();
  const r = B.settle(p, [bar(T0, 100, 105, 97, 101)], T0 + 2 * H);
  assert.deepStrictEqual(r.done.slice(0, 2), [98, 'stop']);
  // sam cel w świecy wejścia → pozycja dalej otwarta
  const p2 = longPos();
  const r2 = B.settle(p2, [bar(T0, 100, 105, 99, 101)], T0 + 2 * H);
  assert.strictEqual(r2.done, null);
  assert.strictEqual(p2.checkedTo, T0 + H);
});

test('świeca wejścia nie jest pomijana: stop po wejściu w tej samej godzinie zamyka pozycję', () => {
  const p = longPos();
  const r = B.settle(p, [bar(T0, 100, 100.5, 97.5, 98)], T0 + 2 * H);
  assert.strictEqual(r.done[1], 'stop');
});

test('cel i stop w tej samej świecy → liczymy stop', () => {
  const p = longPos();
  const r = B.settle(p, [bar(T0, 100, 100, 99.5, 100), bar(T0 + H, 100, 105, 97, 103)], T0 + 3 * H);
  assert.deepStrictEqual(r.done.slice(0, 2), [98, 'stop']);
});

test('luka przez stop: wyjście po cenie otwarcia, nie po stopie', () => {
  const p = longPos();
  const r = B.settle(p, [bar(T0, 100, 100, 99.5, 100), bar(T0 + H, 95, 96, 94, 95)], T0 + 3 * H);
  assert.strictEqual(r.done[0], 95);
  assert.strictEqual(r.done[3].gap, true);
});

test('dwukrotne przetworzenie identycznych świec nie tworzy nowych zdarzeń', () => {
  const p = longPos({ trail: true, rDist: 2, best: 100 });
  const bars = [bar(T0, 100, 100, 99.5, 100), bar(T0 + H, 100, 106, 99, 105)];
  const r1 = B.settle(p, bars, T0 + 3 * H);
  assert.strictEqual(r1.done, null);
  const stopAfter = p.stop, checked = p.checkedTo;
  assert.strictEqual(stopAfter, 104); // szczyt 106 − 1R
  const r2 = B.settle(p, bars, T0 + 3 * H); // te same dane jeszcze raz
  assert.strictEqual(r2.done, null);
  assert.strictEqual(p.stop, stopAfter);
  assert.strictEqual(p.checkedTo, checked);
});

test('ciągnięty stop nie zamyka na dołku tej samej świecy, która go podniosła', () => {
  // świeca: dołek 99 (przed albo po szczycie 106 – nie wiadomo); nowy stop 104 obowiązuje od następnej świecy
  const p = longPos({ trail: true, rDist: 2, best: 100 });
  const r = B.settle(p, [bar(T0, 100, 100, 99.5, 100), bar(T0 + H, 100, 106, 99, 105)], T0 + 3 * H);
  assert.strictEqual(r.done, null);
  const r2 = B.settle(p, [bar(T0 + 2 * H, 105, 105, 103, 103.5)], T0 + 4 * H);
  assert.deepStrictEqual(r2.done.slice(0, 2), [104, 'ciągnięty stop']);
});

test('niezamknięta świeca nie jest przetwarzana', () => {
  const p = longPos();
  const r = B.settle(p, [bar(T0 + H, 100, 100, 97, 98)], T0 + H + 30 * 6e4);
  assert.strictEqual(r.done, null);
  assert.strictEqual(p.checkedTo, T0 + 30 * 6e4);
});

test('cel osiągnięty dopiero po końcu scenariusza nie jest zaliczany', () => {
  const p = longPos({ end: T0 + 3 * H });
  const bars = [bar(T0, 100, 100, 99.5, 100), bar(T0 + H, 100, 101, 99.5, 100.5), bar(T0 + 2 * H, 100.5, 101, 100, 100.8), bar(T0 + 3 * H, 101, 110, 100, 109)];
  const r = B.settle(p, bars, T0 + 5 * H);
  assert.deepStrictEqual(r.done.slice(0, 2), [100.8, 'czas minął']);
});

test('upływ czasu bez danych: brak wymyślonej ceny, potem jawny znacznik', () => {
  const p = longPos({ end: T0 + 3 * H });
  const early = B.settle(p, [], T0 + 4 * H);          // < koniec + 3 h → czekamy
  assert.strictEqual(early.done, null);
  assert.ok(!early.needLive);
  const late = B.settle(p, [], T0 + 7 * H);           // brak świec → potrzebna cena bieżąca, oznaczona jako brak danych
  assert.strictEqual(late.done, null);
  assert.strictEqual(late.needLive, true);
});

test('mergeBars: świece 1h tylko przed pierwszą świecą 5m, bez trwających świec', () => {
  const k1 = { t: [T0, T0 + H, T0 + 2 * H], o: [1, 1, 1], h: [1, 1, 1], l: [1, 1, 1], c: [1, 1, 1] };
  const k5 = { t: [T0 + H, T0 + H + M5], o: [2, 2], h: [2, 2], l: [2, 2], c: [2, 2] };
  const bars = B.mergeBars(k1, k5, T0 + H + 7 * 6e4);
  assert.deepStrictEqual(bars.map(b => [b.t, b.dur]), [[T0, H], [T0 + H, M5]]);
});

// ---------- dzienny limit i ryzyko ----------
const res = { generatedAt: new Date(T0).toISOString(), coins: [] };
const mkAcct = (over = {}) => ({ balance: 1000, positions: [], closed: [], equity: [], day: null, log: [], ...over });

test('zmiana dnia: strata zaksięgowana w pierwszym skanie nowego dnia liczy się do limitu', async () => {
  // pozycja z otwartą stratą −40 USDT (4%), zamyka się w pierwszym skanie nowego dnia
  const now = Date.UTC(2026, 10, 17, 0, 30); // 01:30 w Polsce, nowy dzień
  const p = { base: 'AAA', sym: 'AAA-USDT', side: 'LONG', entry: 100, stop: 96, target: 108, qty: 10, risk: 40, iv: '1h', openedAt: now - 5 * H, end: now + 19 * H, checkedTo: now - 2 * H };
  const st = mkAcct({ positions: [p], day: { date: '2026-11-16', startEquity: 1000, halted: false } });
  const byBase = new Map([['AAA', { price: 96.5, qv: 1e7, sym: 'AAA-USDT' }]]);
  const bars = [bar(now - 2 * H, 97, 97, 95.5, 96)]; // stop 96 trafiony w zamkniętej świecy
  await B.runAccount('A', st, res, byBase, async () => bars, now);
  assert.strictEqual(st.closed.length, 1);
  // baza dnia ustalona PRZED zaksięgowaniem: equity z otwartą stratą (~965), a nie saldo po stracie
  assert.ok(st.day.startEquity > 960 && st.day.startEquity < 970, 'baza dnia ' + st.day.startEquity);
});

test('limit dzienny uwzględnia otwarte straty i blokuje wejścia do końca dnia', async () => {
  const now = Date.UTC(2026, 10, 16, 12, 0);
  const p = { base: 'AAA', sym: 'AAA-USDT', side: 'LONG', entry: 100, stop: 90, target: 120, qty: 4, risk: 40, iv: '1h', openedAt: now - 2 * H, end: now + 22 * H, checkedTo: now };
  const st = mkAcct({ positions: [p], day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['AAA', { price: 91, qv: 1e7, sym: 'AAA-USDT' }]]); // otwarta strata −36 USDT
  await B.runAccount('A', st, res, byBase, async () => [], now);
  assert.strictEqual(st.balance, 1000);       // nic nie zaksięgowano
  assert.strictEqual(st.day.halted, true);    // ale limit działa na equity
  // cena wraca – blokada zostaje do końca dnia
  byBase.set('AAA', { price: 99, qv: 1e7, sym: 'AAA-USDT' });
  await B.runAccount('A', st, res, byBase, async () => [], now + H);
  assert.strictEqual(st.day.halted, true);
});

test('ryzyko pozycji liczone z kosztami; stop na zysku = ryzyko tylko kosztów', () => {
  const r = B.openRisk({ side: 'LONG', entry: 100, stop: 98, qty: 1 });
  assert.ok(r > 2 && r < 2.3);
  const r2 = B.openRisk({ side: 'LONG', entry: 100, stop: 103, qty: 1 });
  assert.ok(r2 < 0.3);
});

test('walidacja wejścia: nieaktualny skan, uciekła cena, zły stop', () => {
  const c = { side: 'LONG', stopPct: 2, movePct: 4, tickerPrice: 100, signalPrice: 100 };
  const live = { price: 100.5, qv: 1e7 };
  assert.strictEqual(B.rejectEntry(c, live, 0, 0), null);
  assert.strictEqual(B.rejectEntry(c, live, 0, 4 * H), 'nieaktualne wyniki skanu');
  assert.strictEqual(B.rejectEntry(c, { price: 102, qv: 1e7 }, 0, 0), 'cena uciekła od sygnału');
  assert.strictEqual(B.rejectEntry({ ...c, stopPct: 0 }, live, 0, 0), 'zły cel/stop');
  assert.strictEqual(B.rejectEntry(c, { price: NaN, qv: 1e7 }, 0, 0), 'brak ceny');
});

// ---------- stan ----------
test('awaria odczytu stanu nie zakłada nowych kont', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-'));
  const f = path.join(dir, 'bot.json');
  assert.throws(() => B.loadState({ BOT_PREV_STATUS: 'error', BOT_IN: f }));            // błąd pobrania
  assert.throws(() => B.loadState({ BOT_PREV_STATUS: 'ok', BOT_IN: f }));               // brak pliku mimo „ok”
  fs.writeFileSync(f, '{"accounts": {"A": ');                                          // uszkodzony JSON
  assert.throws(() => B.loadState({ BOT_PREV_STATUS: 'ok', BOT_IN: f }));
  fs.writeFileSync(f, JSON.stringify({ accounts: { A: { balance: 'x', positions: [], closed: [] } } }));
  assert.throws(() => B.loadState({ BOT_PREV_STATUS: 'ok', BOT_IN: f }));               // zły stan
  assert.strictEqual(B.loadState({ BOT_PREV_STATUS: 'missing' }), null);               // pierwszy start – dozwolony
  fs.writeFileSync(f, JSON.stringify({ accounts: { A: { balance: 990, positions: [], closed: [] } } }));
  assert.strictEqual(B.loadState({ BOT_PREV_STATUS: 'ok', BOT_IN: f }).accounts.A.balance, 990);
});

test('zapis stanu jest atomowy i odrzuca uszkodzony stan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-'));
  const f = path.join(dir, 'bot.json');
  B.saveState(f, { accounts: { A: { balance: 1000, positions: [], closed: [] } } });
  assert.ok(fs.existsSync(f) && !fs.existsSync(f + '.tmp'));
  assert.throws(() => B.saveState(f, { accounts: { A: { balance: NaN, positions: [], closed: [] } } }));
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).accounts.A.balance, 1000); // stary plik nietknięty
});

test('spread szerszy niż zakładany poślizg blokuje wejście; brak danych o spreadzie nie blokuje', () => {
  const c = { side: 'LONG', stopPct: 2, movePct: 4, tickerPrice: 100, signalPrice: 100 };
  assert.strictEqual(B.rejectEntry(c, { price: 100, qv: 1e7, bid: 99.8, ask: 100.2 }, 0, 0), 'za szeroki spread');
  assert.strictEqual(B.rejectEntry(c, { price: 100, qv: 1e7, bid: 99.99, ask: 100.01 }, 0, 0), null);
  assert.strictEqual(B.rejectEntry(c, { price: 100, qv: 1e7 }, 0, 0), null);
});

test('tryb obserwacji: spadek equity od szczytu albo seria złych wyników', () => {
  assert.match(B.observeCheck({ peakEquity: 1100, closed: [] }, 980), /spadek equity/);
  assert.strictEqual(B.observeCheck({ peakEquity: 1000, closed: [] }, 950), null);
  const bad = Array.from({ length: 30 }, () => ({ r: -0.4 }));
  assert.match(B.observeCheck({ peakEquity: 1000, closed: bad }, 990), /ostatnie 30/);
  const ok = Array.from({ length: 30 }, (_, i) => ({ r: i % 2 ? 2 : -1 }));
  assert.strictEqual(B.observeCheck({ peakEquity: 1000, closed: ok }, 1000), null);
});

test('strategia z trendem: stop ciągnięty tylko na zamknięciach dnia, bez celu', () => {
  const D = 864e5, d0 = Date.UTC(2026, 10, 10);
  const p = { side: 'LONG', entry: 100, stop: 90, target: 1e8, qty: 1, openedAt: d0 + 3600e3, end: d0 + 42 * D, checkedTo: d0 + 3600e3, trail: true, chandelier: true, rDist: 10, best: 100 };
  const day = (i, o, h, l, c) => ({ t: d0 + i * D, dur: D, o, h, l, c });
  // dzień 0 = świeca wejścia; dzień 1: szczyt 130, zamknięcie 120 → stop 110 (od następnego dnia)
  let r = B.settle(p, [day(0, 100, 101, 99, 100), day(1, 100, 130, 95, 120)], d0 + 3 * D);
  assert.strictEqual(r.done, null);
  assert.strictEqual(p.stop, 110);
  r = B.settle(p, [day(2, 118, 119, 109, 112)], d0 + 4 * D);
  assert.deepStrictEqual(r.done.slice(0, 2), [110, 'ciągnięty stop']);
});

// ---------- konto F: kopia aplikacji ----------
test('konto F: zlecenie z limitem po cenie z aplikacji → wykonanie → cel z aplikacji', async () => {
  const now = Date.UTC(2026, 10, 20, 10, 5);
  const hist = [{ id: 'x1', method: 2, status: 'open', t: now - 3 * 6e4, end: now + 24 * H, iv: '1h', ex: 'bingx', base: 'AAA', dir: 'LONG', price: 100, target: 104, stop: 98, p: 0.4, lift: 0.1 },
    { id: 'x2', method: 2, status: 'open', t: now - 3 * 6e4, end: now + 24 * H, iv: '1h', ex: 'okx', base: 'BBB', dir: 'SHORT', price: 50, target: 48, stop: 51, p: 0.4, lift: 0.09 }];
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['AAA', { price: 100.1, qv: 1e7, sym: 'AAA-USDT' }], ['BBB', { price: 49.8, qv: 1e7, sym: 'BBB-USDT' }]]); // BBB uciekło o 0,4%
  const r1 = { ...res, generatedAt: new Date(now).toISOString(), history: hist };
  await B.runAccount('F', st, r1, byBase, async () => [], now);
  // AAA (BingX): zlecenie z limitem po 100; BBB (OKX): wejście od razu po cenie BingX, cel/stop w tych samych %
  assert.strictEqual(st.pending.length, 1);
  assert.strictEqual(st.pending[0].limit, 100);
  assert.strictEqual(st.positions.length, 1);
  const bb = st.positions[0]; assert.strictEqual(bb.base, 'BBB');
  assert.ok(Math.abs(bb.target / 49.8 - 48 / 50) < 1e-9 && Math.abs(bb.stop / 49.8 - 51 / 50) < 1e-9);
  st.positions = []; // dalej sprawdzamy tylko AAA
  // godzinę później: świeca 5m po złożeniu zlecenia schodzi do 99,9 → wykonanie po 100, potem cel 104
  const bars = [bar(now - 6e4, 100.1, 100.2, 99.0, 100, M5), // świeca, w której złożono zlecenie – nie liczy się
    { t: now + 10 * 6e4, dur: M5, o: 100.1, h: 100.3, l: 99.9, c: 100.2 }, { t: now + 30 * 6e4, dur: M5, o: 101, h: 104.5, l: 100.8, c: 104 }];
  await B.runAccount('F', st, { ...r1, history: hist }, byBase, async sym => sym === 'AAA-USDT' ? bars : [], now + H);
  assert.strictEqual(st.pending.length, 0);
  assert.strictEqual(st.closed.length, 1);
  assert.strictEqual(st.closed[0].entry, 100);
  assert.strictEqual(st.closed[0].reason, 'cel');
  assert.ok(st.closed[0].r > 1.6 && st.closed[0].r < 2, 'R ' + st.closed[0].r);
  // ten sam scenariusz nie jest brany drugi raz
  await B.runAccount('F', st, { ...r1, history: hist }, byBase, async () => [], now + 2 * H);
  assert.strictEqual(st.pending.length + st.positions.length, 0);
});

test('konto F: zlecenie z limitem wygasa, gdy cena nie wróci', async () => {
  const now = Date.UTC(2026, 10, 20, 10, 5);
  const o = { id: 'o', base: 'AAA', sym: 'AAA-USDT', side: 'LONG', iv: '1h', limit: 100, target: 104, stop: 98, end: now + 24 * H, placedAt: now, expires: now + H };
  const st = mkAcct({ pending: [o], lastPickT: now, day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['AAA', { price: 101, qv: 1e7, sym: 'AAA-USDT' }]]);
  await B.runAccount('F', st, { ...res, generatedAt: new Date(now).toISOString(), history: [] }, byBase, async () => [{ t: now + 6e5, dur: M5, o: 100.5, h: 101, l: 100.2, c: 101 }], now + H + 6e4);
  assert.strictEqual(st.pending.length, 0);
  assert.strictEqual(st.positions.length, 0);
  assert.ok(st.log[0].includes('wygasło'));
});

test('konto F: pomija scenariusze 14-dniowe', () => {
  const now = Date.UTC(2026, 10, 20, 10, 5);
  const mk = iv => ({ id: iv, ex: 'bingx', method: 2, status: 'open', t: now - 6e4, end: now + 99 * H, iv, base: 'A' + iv, dir: 'LONG', price: 1, target: 1.1, stop: 0.95 });
  assert.deepStrictEqual(B.copyCandidates({}, [mk('1h'), mk('4h'), mk('1d')], now).map(p => p.iv).sort(), ['1h', '4h']);
});

// ---------- konto G: wskaźniki ----------
// trend + odbicie (6 świec, słaby wolumen) + świeca odrzucenia
function trendK(dir, bounceVol = 50) {
  const k = { t: [], o: [], h: [], l: [], c: [], v: [] }, now = Date.UTC(2026, 10, 20, 10, 0), N = 90, s = dir === 'down' ? 1 : -1; let p = 100;
  for (let i = 0; i < N; i++) {
    const o = p, c = i < N - 7 ? p * (1 - s * 0.006 * (1 + 0.3 * Math.sin(i))) : i < N - 1 ? p * (1 + s * 0.012) : p * (1 - s * 0.025);
    k.t.push(now - (N - i) * H); k.o.push(o); k.c.push(c); k.h.push(Math.max(o, c) * 1.002); k.l.push(Math.min(o, c) * 0.998); k.v.push(i >= N - 6 ? bounceVol : 100); p = c;
  }
  return { k, now };
}
test('konto G: short po odbiciu w trendzie spadkowym, long po korekcie we wzrostowym', () => {
  const a = trendK('down'), b = trendK('up');
  assert.strictEqual(B.indSignal(a.k, a.now).side, 'SHORT');
  assert.strictEqual(B.indSignal(b.k, b.now).side, 'LONG');
  const sg = B.indSignal(a.k, a.now); assert.ok(sg.stopPct >= 1.3 && sg.stopPct <= 8);
});
test('konto G: brak sygnału, gdy odbicie na mocnym wolumenie albo świece nieświeże', () => {
  const a = trendK('down', 150); assert.strictEqual(B.indSignal(a.k, a.now), null);
  const b = trendK('down'); assert.strictEqual(B.indSignal(b.k, b.now + 3 * H), null);
});
for (const [PG, n] of [[0.5, 1], [0.4, 1], [0.35, 0]]) test(`konto G: model 2:1 ${PG * 100}% → ${n ? 'wchodzi (cel 2R, ciągnięcie zysku)' : 'pomija (poniżej 38%)'}`, async () => {
  const { k, now } = trendK('down');
  const price = k.c[k.c.length - 1];
  const res2 = { generatedAt: new Date(now).toISOString(), coins: [{ ex: 'bingx', base: 'YNG', sym: 'YNG-USDT', price, res: { '1h': { price, ma: { ema20: price * 1.01, ema50: price * 1.08 }, big: { short: { p: PG }, long: { p: 0.2 } } } } }], klines1h: async () => k };
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['YNG', { price, qv: 1e7, sym: 'YNG-USDT' }]]);
  await B.runAccount('G', st, res2, byBase, async () => [], now);
  assert.strictEqual(st.positions.length, n);
  if (!n) return;
  const p = st.positions[0];
  assert.strictEqual(p.side, 'SHORT'); assert.strictEqual(p.mode, 'ind'); assert.strictEqual(p.trail, true);
  assert.ok(Math.abs((p.entry - p.target) / (p.stop - p.entry) - 2) < 0.01);
});

test('powiadomienie: tylko nowe wpisy z dziennika, z ikonami; brak zdarzeń → brak wiadomości', () => {
  const now = Date.UTC(2026, 10, 21, 10, 5);
  const state = { accounts: { A: { balance: 1012.3, log: ['2026-11-21T10:05 zamknięto XPIN SHORT (cel) +18.40 USDT', '2026-11-21T10:05 otwarto JAGENT LONG (24 godz., 2:1) po 3.2090e-6', '2026-11-20T08:05 stare'] }, G: { balance: 990, log: ['2026-11-20T08:05 stare'] } } };
  const msg = B.buildNotice(state, { A: 1, G: 1 }, now);
  assert.ok(msg.includes('🟢 A · otwarto JAGENT LONG'));
  assert.ok(msg.includes('✅ A · zamknięto XPIN SHORT'));
  assert.ok(!msg.includes('stare')); assert.ok(!msg.includes('2026-'));
  assert.ok(msg.includes('Salda: A 1012 · G 990'));
  assert.strictEqual(B.buildNotice(state, { A: 3, G: 1 }, now), null);
});

test('konto H: kopia aplikacji, po celu ciągnie zysk zamiast zamykać', async () => {
  const now = Date.UTC(2026, 10, 23, 10, 5);
  const hist = [{ id: 'h1', ex: 'bingx', method: 2, status: 'open', t: now - 3 * 6e4, end: now + 24 * H, iv: '1h', base: 'AAA', dir: 'LONG', price: 100, target: 104, stop: 98, p: 0.4, lift: 0.1 }];
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['AAA', { price: 99.9, qv: 1e7, sym: 'AAA-USDT' }]]);
  await B.runAccount('H', st, { ...res, generatedAt: new Date(now).toISOString(), history: hist }, byBase, async () => [], now);
  assert.strictEqual(st.positions.length, 1);
  const p = st.positions[0];
  assert.strictEqual(p.mode, 'copytrail'); assert.strictEqual(p.trail, true);
  assert.ok(p.end > hist[0].end, 'dłuższy horyzont');
  // cena idzie do 106 (powyżej celu 104), potem cofa do 103 → wyjście na ciągniętym stopie ok. 104 (106 − 1R=2)
  const bars = [{ t: now + 6e5, dur: M5, o: 100, h: 102, l: 99.8, c: 101.5 }, { t: now + 12e5, dur: M5, o: 101.5, h: 106, l: 101.4, c: 105.5 },
    { t: now + 18e5, dur: M5, o: 105.5, h: 105.6, l: 103, c: 103.2 }];
  await B.runAccount('H', st, { ...res, generatedAt: new Date(now).toISOString(), history: hist }, byBase, async () => bars, now + H);
  assert.strictEqual(st.closed.length, 1);
  assert.strictEqual(st.closed[0].reason, 'ciągnięty stop');
  assert.ok(st.closed[0].r > 1.7, 'R ' + st.closed[0].r);
});

// ---------- konto I: trader ----------
function upK(now) {
  const k = { t: [], o: [], h: [], l: [], c: [], v: [] }; let p = 80; const N = 60, t0 = Math.floor(now / H) * H - N * H;
  for (let i = 0; i < N; i++) { const o = p, c = p * (1.004 + 0.002 * Math.sin(i)); k.t.push(t0 + i * H); k.o.push(o); k.c.push(c); k.h.push(c * 1.002); k.l.push(o * 0.998); k.v.push(100 + i); p = c; }
  return k;
}
test('konto I: obserwuje scenariusz, wchodzi dopiero po wybiciu szczytu, stop i cel ze scenariusza', async () => {
  const now = Date.UTC(2026, 10, 25, 10, 20);
  const k = upK(now); const last = k.c[k.c.length - 1]; const lvl = Math.max(k.h[k.h.length - 1], k.h[k.h.length - 2]);
  const coin = { ex: 'bingx', base: 'TTT', sym: 'TTT-USDT', price: last, res: { '1h': { price: last, raw: {}, big: { long: { p: 0.45, prior: 0.32, skill: 0.02, weak: false }, short: { p: 0.2, prior: 0.3, skill: 0, weak: true }, levels: { longT: last * 1.04, longS: last * 0.98, shortT: last * 0.96, shortS: last * 1.02 } } } } };
  const r = { generatedAt: new Date(now).toISOString(), coins: [coin], klines1h: async () => k, klines4h: async () => null };
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['TTT', { price: last, qv: 1e7, sym: 'TTT-USDT' }]]);
  await B.runAccount('I', st, r, byBase, async () => [], now);
  assert.strictEqual(st.positions.length, 0);
  assert.strictEqual(st.watch.length, 1);
  assert.ok(st.watch[0].armedAt, 'uzbrojony (≥2/5): ' + st.watch[0].lastTxt);
  // 5m: najpierw bez wybicia, potem wybicie lvl, potem cel
  const bars = [{ t: now + 5 * 6e4, dur: M5, o: last, h: last * 1.0005, l: last * 0.999, c: last },
    { t: now + 15 * 6e4, dur: M5, o: last, h: lvl * 1.001, l: last * 0.999, c: lvl },
    { t: now + 30 * 6e4, dur: M5, o: lvl, h: last * 1.045, l: lvl * 0.999, c: last * 1.04 }];
  await B.runAccount('I', st, r, byBase, async () => bars, now + H);
  // po celu pozycja trwa dalej (ciągnięcie zysku), stop zabezpiecza co najmniej połowę drogi do celu
  assert.strictEqual(st.closed.length, 0);
  const pp = st.positions[0]; assert.ok(pp.trailing && pp.stop >= pp.entry + (pp.lockHalf - pp.entry) * 0.5 - 1e-9);
  assert.ok(Math.abs(pp.entry - lvl) < 1e-9);
  assert.ok(st.log.some(l => /otwarto TTT LONG .*wybicie .*✓/.test(l)));
  // cofnięcie → wyjście na ciągniętym stopie z zyskiem
  await B.runAccount('I', st, r, byBase, async () => [{ t: now + H + 10 * 6e4, dur: M5, o: last * 1.04, h: last * 1.041, l: last * 1.0, c: last * 1.0 }], now + 2 * H);
  assert.strictEqual(st.closed.length, 1); assert.strictEqual(st.closed[0].reason, 'ciągnięty stop'); assert.ok(st.closed[0].net > 0);
});
test('konto I: rezygnuje, gdy cena dotknie stopu przed wybiciem', async () => {
  const now = Date.UTC(2026, 10, 25, 10, 20);
  const k = upK(now); const last = k.c[k.c.length - 1];
  const coin = { ex: 'bingx', base: 'TTT', sym: 'TTT-USDT', price: last, res: { '1h': { price: last, raw: {}, big: { long: { p: 0.45, prior: 0.32, skill: 0.02, weak: false }, short: { p: 0.2, prior: 0.3, skill: 0, weak: true }, levels: { longT: last * 1.04, longS: last * 0.98, shortT: last * 0.96, shortS: last * 1.02 } } } } };
  const r = { generatedAt: new Date(now).toISOString(), coins: [coin], klines1h: async () => k, klines4h: async () => null };
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['TTT', { price: last, qv: 1e7, sym: 'TTT-USDT' }]]);
  await B.runAccount('I', st, r, byBase, async () => [], now);
  await B.runAccount('I', st, r, byBase, async () => [{ t: now + 10 * 6e4, dur: M5, o: last, h: last * 1.0001, l: last * 0.975, c: last * 0.976 }], now + H);
  assert.strictEqual(st.positions.length + st.closed.length + st.watch.length, 0);
  assert.ok(st.log[0].includes('dotknęła stopu przed wybiciem'));
});
test('konto I: nie wchodzi, gdy cena przeskoczy wybicie tak daleko, że do celu zostaje < 1,2R', async () => {
  const now = Date.UTC(2026, 10, 25, 10, 20);
  const k = upK(now); const last = k.c[k.c.length - 1];
  const coin = { ex: 'bingx', base: 'TTT', sym: 'TTT-USDT', price: last, res: { '1h': { price: last, raw: {}, big: { long: { p: 0.45, prior: 0.32, skill: 0.02, weak: false }, short: { p: 0.2, prior: 0.3, skill: 0, weak: true }, levels: { longT: last * 1.04, longS: last * 0.98, shortT: last * 0.96, shortS: last * 1.02 } } } } };
  const r = { generatedAt: new Date(now).toISOString(), coins: [coin], klines1h: async () => k, klines4h: async () => null };
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map([['TTT', { price: last, qv: 1e7, sym: 'TTT-USDT' }]]);
  await B.runAccount('I', st, r, byBase, async () => [], now);
  // świeca otwiera się od razu +3% (cel +4%, stop −2%) → zostaje ok. 0,2R
  await B.runAccount('I', st, r, byBase, async () => [{ t: now + 10 * 6e4, dur: M5, o: last * 1.03, h: last * 1.032, l: last * 1.029, c: last * 1.031 }], now + H);
  assert.strictEqual(st.positions.length + st.closed.length, 0);
  assert.ok(st.log.some(l => l.includes('przeskoczyła za daleko')));
});

test('limit korelacji: maks. 2 nowe pozycje w tym samym kierunku na godzinę (konto F)', async () => {
  const now = Date.UTC(2026, 10, 26, 10, 5);
  const mk = (b, i) => ({ id: b, ex: 'bingx', method: 2, status: 'open', t: now - 6e4 + i, end: now + 24 * H, iv: '1h', base: b, dir: 'SHORT', price: 100, target: 96, stop: 102, p: 0.4, lift: 0.1 - i * 0.001 });
  const hist = ['AAA', 'BBB', 'CCC', 'DDD'].map(mk);
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  const byBase = new Map(['AAA', 'BBB', 'CCC', 'DDD'].map(b => [b, { price: 100.1, qv: 1e7, sym: b + '-USDT' }]));
  await B.runAccount('F', st, { ...res, generatedAt: new Date(now).toISOString(), history: hist }, byBase, async () => [], now);
  assert.strictEqual(st.positions.length, 2);
  assert.ok(st.log.some(l => l.includes('limit korelacji')));
});
test('konto I: nie obserwuje scenariusza, gdy poziom wybicia jest za blisko celu (< 1,2 : 1)', async () => {
  const now = Date.UTC(2026, 10, 26, 10, 20);
  const k = upK(now); const last = k.c[k.c.length - 1];
  // cel tylko 0,5% nad ceną, a wybicie ~0,2% wyżej → zysk : ryzyko przy wybiciu < 1,2
  const coin = { ex: 'bingx', base: 'TTT', sym: 'TTT-USDT', price: last, res: { '1h': { price: last, raw: {}, big: { long: { p: 0.45, prior: 0.32, skill: 0.02, weak: false }, short: { p: 0.2, prior: 0.3, skill: 0, weak: true }, levels: { longT: last * 1.015, longS: last * 0.985, shortT: last * 0.96, shortS: last * 1.02 } } } } };
  const r = { generatedAt: new Date(now).toISOString(), coins: [coin], klines1h: async () => k, klines4h: async () => null };
  const st = mkAcct({ day: { date: B.dayKey(now), startEquity: 1000, halted: false } });
  await B.runAccount('I', st, r, new Map([['TTT', { price: last, qv: 1e7, sym: 'TTT-USDT' }]]), async () => [], now);
  assert.strictEqual((st.watch || []).length, 0);
  assert.ok(st.log.some(l => l.includes('za blisko celu')));
});
