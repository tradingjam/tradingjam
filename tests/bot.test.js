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
