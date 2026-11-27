// Wersja angielska: generator nie może zostawić polskich tekstów ani zepsuć plików
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
test('make-en: brak polskich znaków w kodzie wersji EN', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-en-'));
  for (const f of ['App.js', 'engine.js']) fs.copyFileSync(path.join(__dirname, '..', 'app', f), path.join(d, f));
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'make-en.js'), d, '--switch']);
  for (const f of ['App.en.js', 'engine.en.js']) {
    const left = fs.readFileSync(path.join(d, f), 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, ''))
      .filter(l => /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(l) && !/errText = e =>/.test(l));
    assert.deepStrictEqual(left, [], `${f}: nieprzetłumaczone linie`);
  }
  assert.ok(fs.readFileSync(path.join(d, 'App.en.js'), 'utf8').includes("const LANG = 'en';"));
  assert.ok(fs.existsSync(path.join(d, 'App.pl.js')));
});
