// Generuje angielską wersję aplikacji (App.en.js, engine.en.js) z polskich plików i słownika app/i18n/en.json.
// Polski kod zostaje jedynym źródłem – po zmianie tekstów w App.js wystarczy dopisać tłumaczenie do en.json.
// Użycie: node scripts/make-en.js <katalog z App.js i engine.js> [--report]
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || path.join(__dirname, '..', 'app');
const report = process.argv.includes('--report');
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'i18n', 'en.json'), 'utf8'));
const pairs = Object.entries(MAP).filter(([k]) => !k.startsWith('//')).sort((a, b) => b[0].length - a[0].length);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function translate(src) {
  const used = new Set();
  // zamiana w jednym przejściu (dłuższe frazy najpierw), żeby tłumaczenie nie było tłumaczone drugi raz
  const longP = pairs.filter(([k]) => k.length >= 12 && /\s/.test(k)), shortP = pairs.filter(([k]) => !(k.length >= 12 && /\s/.test(k)));
  const reLong = longP.length ? new RegExp(longP.map(([k]) => esc(k)).join('|'), 'g') : null;
  const mLong = new Map(longP);
  if (reLong) src = src.replace(reLong, m => { used.add(m); return mLong.get(m); });
  // krótkie: tylko w granicach cudzysłowów / znaczników JSX, żeby nie ruszyć kodu
  const mShort = new Map(shortP);
  if (shortP.length) {
    const reShort = new RegExp(`(?<=['"\`>}]\\s*)(${shortP.map(([k]) => esc(k)).join('|')})(?=\\s*['"\`<{$])`, 'g');
    src = src.replace(reShort, m => { used.add(m); return mShort.get(m); });
  }
  return { src, used };
}
const out = {}, allUsed = new Set();
for (const f of ['App.js', 'engine.js']) {
  let { src, used } = translate(fs.readFileSync(path.join(dir, f), 'utf8'));
  used.forEach(u => allUsed.add(u));
  if (f === 'App.js') src = src.replace(/require\('\.\/engine'\)/g, "require('./engine.en')").replace(/'pl-PL'/g, "'en-GB'").replace("const LANG = 'pl';", "const LANG = 'en';");
  out[f.replace('.js', '.en.js')] = src;
}
for (const [f, s] of Object.entries(out)) fs.writeFileSync(path.join(dir, f), s);
// --switch (tylko przy budowaniu): App.js -> App.pl.js, a App.js wybiera wersję wg zapisanego wyboru albo języka telefonu
if (process.argv.includes('--switch')) {
  fs.renameSync(path.join(dir, 'App.js'), path.join(dir, 'App.pl.js'));
  fs.writeFileSync(path.join(dir, 'App.js'), `import React, { useState } from 'react';
import AppPl from './App.pl';
import AppEn from './App.en';
const KEY = 'tj_lang';
function initialLang() {
  try { const s = globalThis.localStorage && localStorage.getItem(KEY); if (s === 'pl' || s === 'en') return s; } catch (e) { }
  try { if (typeof navigator !== 'undefined' && navigator.language) return navigator.language.toLowerCase().startsWith('pl') ? 'pl' : 'en'; } catch (e) { }
  try { const l = Intl.DateTimeFormat().resolvedOptions().locale || ''; if (l) return l.toLowerCase().startsWith('pl') ? 'pl' : 'en'; } catch (e) { }
  return 'pl';
}
export default function App() {
  const [lang, setLang] = useState(initialLang);
  globalThis.__tjSetLang = l => { try { globalThis.localStorage && localStorage.setItem(KEY, l); } catch (e) { } setLang(l); };
  return lang === 'en' ? <AppEn /> : <AppPl />;
}
`);
}
if (report) {
  const PL = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]|\b(się|nie|jest|oraz|lub|dla|przy|gdy|już|czy|tylko|bez|brak|ceny?|świec|godz|dni|wynik|zysk|strata|konto|giełd\w*)\b/;
  for (const [f, s] of Object.entries(out)) s.split('\n').forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, '');
    const strs = code.match(/(['"`])(?:\\.|(?!\1).)*\1|>[^<>{}]*[<{]/g) || [];
    if (strs.some(x => PL.test(x))) console.log(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`);
  });
  const unused = pairs.filter(([k]) => !allUsed.has(k)).map(([k]) => k);
  if (unused.length) console.log('NIEUŻYTE:', unused.length, unused.slice(0, 30));
}
