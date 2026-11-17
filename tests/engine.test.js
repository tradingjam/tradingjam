// Testy silnika: normalizacja bez danych z przyszłości i rozliczanie scenariuszy w historii (resolvePick).
const test = require('node:test');
const assert = require('node:assert');
const E = require('../app/engine.js');
const I = E._internal;

test('normalizacja walk-forward nie zależy od danych z przyszłości', () => {
  const F = [];
  for (let i = 0; i < 100; i++) F.push([i % 7, Math.sin(i)]);
  const F2 = F.map(r => r.slice());
  for (let i = 60; i < 100; i++) F2[i] = [1000 + i, -500]; // zupełnie inna „przyszłość”
  const a = I.foldZ(F)(50), b = I.foldZ(F2)(50);
  for (let i = 0; i <= 50; i++) assert.deepStrictEqual(a[i], b[i]);
  // a pełna normalizacja (stara metoda) by się różniła – to był przeciek
  assert.notDeepStrictEqual(I.zscore(F)[10], I.zscore(F2)[10]);
});

const H = 36e5, T0 = Date.UTC(2026, 10, 16, 10, 0);
const path = rows => ({ t: rows.map(r => r[0]), h: rows.map(r => r[1]), l: rows.map(r => r[2]), c: rows.map(r => r[3]) });
const pick = (over = {}) => ({ status: 'open', dir: 'LONG', price: 100, target: 104, stop: 98, t: T0 + 30 * 6e4, end: T0 + 24 * H, ...over });

test('resolvePick: cel w świecy zapisu nie jest zaliczany, stop tak', () => {
  assert.strictEqual(E.resolvePick(pick(), path([[T0, 105, 99, 101]]), T0 + 2 * H).status, 'open');
  assert.strictEqual(E.resolvePick(pick(), path([[T0, 105, 97, 101]]), T0 + 2 * H).status, 'loss');
});

test('resolvePick: cel i stop w jednej świecy → strata; cel po końcu nie liczy się', () => {
  assert.strictEqual(E.resolvePick(pick(), path([[T0 + H, 105, 97, 101]]), T0 + 3 * H).status, 'loss');
  const pk = pick({ end: T0 + 3 * H });
  const r = E.resolvePick(pk, path([[T0 + H, 101, 99.5, 100.5], [T0 + 2 * H, 101, 100, 100.8], [T0 + 3 * H, 110, 100, 109]]), T0 + 5 * H);
  assert.strictEqual(r.status, 'expired');
  assert.strictEqual(r.r, 0.4); // (100.8 − 100) / 2
});

test('resolvePick: koniec czasu bez świec → brak danych, bez wymyślonej ceny', () => {
  const pk = pick({ end: T0 + 3 * H });
  const r = E.resolvePick(pk, path([[T0 + 4 * H, 101, 99, 100]]), T0 + 6 * H);
  assert.strictEqual(r.status, 'expired');
  assert.strictEqual(r.noData, true);
});
