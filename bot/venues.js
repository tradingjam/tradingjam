// Ceny z innych giełd dla kont na sucho O (OKX Europe) i K (Kraken).
// Zwracają ten sam kształt co BingX w bocie: tickery { ex, sym, base, price, bid, ask } i świece { t, o, h, l, c, v }.
const get = async url => { const r = await fetch(url, { headers: { 'User-Agent': 'tradingjam-bot' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const kl = rows => { const k = { t: [], o: [], h: [], l: [], c: [], v: [] }; for (const [t, o, h, l, c, v] of rows.sort((a, b) => a[0] - b[0])) { k.t.push(t); k.o.push(o); k.h.push(h); k.l.push(l); k.c.push(c); k.v.push(v); } return k; };

// OKX: kontrakty perpetual USDT, ograniczone do coinów, które OKX Europe ma jako X-Perps (kontrakty terminowe w ofercie dla EOG)
const OKX = 'https://www.okx.com';
async function okxTickers() {
  const [sw, fu] = await Promise.all([get(`${OKX}/api/v5/market/tickers?instType=SWAP`), get(`${OKX}/api/v5/public/instruments?instType=FUTURES`)]);
  const eu = new Set((fu.data || []).filter(i => i.state === 'live').map(i => (i.ctValCcy || i.uly || i.instId).split('-')[0].toUpperCase()));
  return (sw.data || []).filter(t => /^[A-Z0-9]{2,20}-USDT-SWAP$/.test(t.instId)).map(t => ({ ex: 'okx', sym: t.instId, base: t.instId.split('-')[0], price: +t.last, bid: +t.bidPx, ask: +t.askPx }))
    .filter(t => eu.has(t.base) && t.price > 0);
}
async function okxKlines(sym, iv, n) {
  const d = await get(`${OKX}/api/v5/market/candles?instId=${sym}&bar=${iv === '1h' ? '1H' : '5m'}&limit=${Math.min(n, 300)}`);
  return kl((d.data || []).map(x => [+x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]));
}

// Kraken Futures: kontrakty perpetual (PF_…USD); dla klientów z UE przez spółkę z licencją MiFID
const KR = 'https://futures.kraken.com';
const krBase = s => s.replace(/^PF_/, '').replace(/USD$/, '').replace(/^XBT$/, 'BTC');
async function krakenTickers() {
  const d = await get(`${KR}/derivatives/api/v3/tickers`);
  return (d.tickers || []).filter(t => /^PF_[A-Z0-9]+USD$/.test(t.symbol) && !t.suspended && t.last > 0)
    .map(t => ({ ex: 'kraken', sym: t.symbol, base: krBase(t.symbol), price: +t.last, bid: +t.bid, ask: +t.ask }));
}
async function krakenKlines(sym, iv, n) {
  const sec = iv === '1h' ? 3600 : 300, to = Math.floor(Date.now() / 1000), from = to - n * sec;
  const d = await get(`${KR}/api/charts/v1/trade/${sym}/${iv === '1h' ? '1h' : '5m'}?from=${from}&to=${to}`);
  return kl((d.candles || []).map(c => [+c.time, +c.open, +c.high, +c.low, +c.close, +c.volume]));
}

const VENUES = { okx: { name: 'OKX Europe', tickers: okxTickers, klines: okxKlines }, kraken: { name: 'Kraken', tickers: krakenTickers, klines: krakenKlines } };
module.exports = { VENUES };
