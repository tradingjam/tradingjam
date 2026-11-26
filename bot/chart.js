// Wykres dla powiadomień konta I: świece 1h, EMA20, wolumen, poziom wybicia, stop, cel (i wejście).
// Zwraca SVG; renderPng() zamienia go na PNG przez @resvg/resvg-js (instalowane w workflow), bez niego zwraca null.
const W = 1000, H = 760, PL = 20, PR = 168, PT = 86, PH = 470, VT = 580, VH = 110;
const C = { bg: '#0b0e14', grid: '#1b2130', text: '#e8e6e1', dim: '#7c8496', up: '#2ecc71', down: '#eb4d4b', ema: '#f5a400', lvl: '#f5a400', stop: '#eb4d4b', target: '#2ecc71', entry: '#e8e6e1' };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = v => v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4);

function chartSVG(k, o) {
  const n = Math.min(48, k.c.length), s = k.c.length - n;
  const O = k.o.slice(s), Hh = k.h.slice(s), Lw = k.l.slice(s), Cc = k.c.slice(s), V = (k.v || []).slice(s);
  // EMA20 liczona na całej historii, pokazana na ostatnich n świecach
  const a = 2 / 21, ema = [k.c[0]]; for (let i = 1; i < k.c.length; i++) ema.push(ema[i - 1] + a * (k.c[i] - ema[i - 1]));
  const E = ema.slice(s);
  const levels = [o.lvl, o.stop, o.target, o.entry].filter(x => x > 0);
  let lo = Math.min(...Lw, ...levels), hi = Math.max(...Hh, ...levels); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const cw = (W - PL - PR) / n, X = i => PL + cw * (i + 0.5), Y = v => PT + (hi - v) / (hi - lo) * PH;
  const vmax = Math.max(...V, 1e-12);
  let g = '';
  for (let q = 0; q <= 4; q++) { const y = PT + PH * q / 4; g += `<line x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`; }
  for (let i = 0; i < n; i++) {
    const up = Cc[i] >= O[i], col = up ? C.up : C.down, x = X(i), bw = Math.max(2, cw * 0.62);
    g += `<line x1="${x}" x2="${x}" y1="${Y(Hh[i])}" y2="${Y(Lw[i])}" stroke="${col}" stroke-width="1.6"/>`;
    const y1 = Y(Math.max(O[i], Cc[i])), y2 = Y(Math.min(O[i], Cc[i]));
    g += `<rect x="${x - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(1.5, y2 - y1)}" fill="${col}"/>`;
    if (V.length) { const vh = (V[i] || 0) / vmax * VH; g += `<rect x="${x - bw / 2}" y="${VT + VH - vh}" width="${bw}" height="${vh}" fill="${col}" opacity="0.45"/>`; }
  }
  g += `<polyline fill="none" stroke="${C.ema}" stroke-width="2" opacity="0.8" points="${E.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`;
  const hline = (v, col, label, dash) => v > 0 ? `<line x1="${PL}" x2="${W - PR + 6}" y1="${Y(v)}" y2="${Y(v)}" stroke="${col}" stroke-width="2" ${dash ? 'stroke-dasharray="8 6"' : ''}/>
    <rect x="${W - PR + 8}" y="${Y(v) - 13}" width="${PR - 12}" height="26" rx="5" fill="${col}"/>
    <text x="${W - PR + 14}" y="${Y(v) + 5}" font-size="14" font-family="DejaVu Sans, Arial" font-weight="bold" fill="${C.bg}">${esc(label)} ${fmt(v)}</text>` : '';
  g += hline(o.target, C.target, 'cel', true) + hline(o.stop, C.stop, 'stop', true) + hline(o.lvl, C.lvl, 'wybicie', true) + (o.entry ? hline(o.entry, C.entry, 'wejście', false) : '');
  const sideCol = o.side === 'LONG' ? C.up : C.down;
  const head = `<text x="${PL}" y="40" font-size="30" font-family="DejaVu Sans, Arial" font-weight="bold" fill="${C.text}">${esc(o.base)} <tspan fill="${sideCol}">${esc(o.side)}</tspan> <tspan font-size="20" fill="${C.dim}" font-weight="normal">· ${esc(o.status)}</tspan></text>
    <text x="${PL}" y="70" font-size="16" font-family="DejaVu Sans, Arial" fill="${C.dim}">${esc(o.sub || '')}</text>
    <text x="${W - PR}" y="40" text-anchor="end" font-size="16" font-family="DejaVu Sans, Arial" fill="${C.dim}">świece 1h · BingX · tradingjam</text>
    <text x="${PL}" y="${VT - 8}" font-size="13" font-family="DejaVu Sans, Arial" fill="${C.dim}">wolumen · linia pomarańczowa = EMA20</text>`;
  const foot = `<text x="${PL}" y="${H - 22}" font-size="15" font-family="DejaVu Sans, Arial" fill="${C.text}">${esc(o.checks || '')}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/>${head}${g}${foot}</svg>`;
}

function renderPng(svg) {
  try {
    let Resvg;
    try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { ({ Resvg } = require(require('path').join(__dirname, 'node_modules', '@resvg/resvg-js'))); }
    return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1000 }, font: { loadSystemFonts: true } }).render().asPng());
  } catch (e) { return null; }
}

module.exports = { chartSVG, renderPng };
