// Wykres dla powiadomień konta I: świece 1h, EMA20, wolumen, poziom wybicia, stop, cel (i wejście).
// Zwraca SVG; renderPng() zamienia go na PNG przez @resvg/resvg-js (instalowane w workflow), bez niego zwraca null.
const W = 1400, H = 800, PL = 20, PR = 168, PT = 86, PH = 500, VT = 615, VH = 115;
const C = { bg: '#0b0e14', grid: '#1b2130', text: '#e8e6e1', dim: '#7c8496', up: '#2ecc71', down: '#eb4d4b', ema: '#f5a400', lvl: '#f5a400', stop: '#eb4d4b', target: '#2ecc71', entry: '#e8e6e1' };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = v => v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4);

function chartSVG(k, o) {
  const n = Math.min(96, k.c.length), s = k.c.length - n;
  const O = k.o.slice(s), Hh = k.h.slice(s), Lw = k.l.slice(s), Cc = k.c.slice(s), V = (k.v || []).slice(s);
  // EMA20 liczona na całej historii, pokazana na ostatnich n świecach
  const a = 2 / 21, ema = [k.c[0]]; for (let i = 1; i < k.c.length; i++) ema.push(ema[i - 1] + a * (k.c[i] - ema[i - 1]));
  const E = ema.slice(s);
  const levels = [o.lvl, o.stop, o.target, o.entry].filter(x => x > 0);
  let lo = Math.min(...Lw, ...levels), hi = Math.max(...Hh, ...levels); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const FUT = 20, cw = (W - PL - PR) / (n + FUT), X = i => PL + cw * (i + 0.5), Y = v => PT + (hi - v) / (hi - lo) * PH;
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
  // linie trendu: dwa ostatnie lokalne szczyty (opór) i dwa ostatnie lokalne dołki (wsparcie), przedłużone w prawo
  const piv = (arr, isHi) => { const out = []; for (let i = 3; i < n - 2; i++) { let ok = true; for (let j = i - 3; j <= Math.min(n - 1, i + 3); j++) if (j !== i && (isHi ? arr[j] > arr[i] : arr[j] < arr[i])) { ok = false; break; } if (ok && (!out.length || i - out[out.length - 1] >= 5)) out.push(i); } return out; };
  const tline = (pts, arr, col, label) => {
    if (pts.length < 2) return '';
    const [i1, i2] = pts.slice(-2), v1 = arr[i1], v2 = arr[i2], slope = (v2 - v1) / (i2 - i1), xe = n - 1 + FUT, ve = v2 + slope * (xe - i2);
    if (!(ve > lo && ve < hi)) return '';
    return `<line x1="${X(i1)}" y1="${Y(v1)}" x2="${X(xe)}" y2="${Y(ve)}" stroke="${col}" stroke-width="1.8" opacity="0.75"/><circle cx="${X(i1)}" cy="${Y(v1)}" r="4" fill="${col}"/><circle cx="${X(i2)}" cy="${Y(v2)}" r="4" fill="${col}"/>
      <text x="${X(i2) + 6}" y="${Y(v2) + (label === 'opór' ? -8 : 18)}" font-size="13" font-family="DejaVu Sans, Arial" fill="${col}">${label}</text>`;
  };
  g += tline(piv(Hh, true), Hh, '#8fa3c7', 'opór') + tline(piv(Lw, false), Lw, '#8fa3c7', 'wsparcie');
  // scenariusz: pola zysku i ryzyka od wejścia (albo poziomu wybicia) w przyszłość + planowany przebieg
  const e0 = o.entry || o.lvl, xa = X(n - 1) + cw * 0.6, xb = X(n - 1 + FUT);
  if (e0 > 0 && o.target > 0 && o.stop > 0) {
    const yE = Y(e0), yT = Y(o.target), yS = Y(o.stop);
    g += `<rect x="${xa}" y="${Math.min(yE, yT)}" width="${xb - xa}" height="${Math.abs(yT - yE)}" fill="${C.target}" opacity="0.16"/>`;
    g += `<rect x="${xa}" y="${Math.min(yE, yS)}" width="${xb - xa}" height="${Math.abs(yS - yE)}" fill="${C.stop}" opacity="0.16"/>`;
    const last = Cc[n - 1], xm = xa + (xb - xa) * 0.28, xt = xb - 10;
    const path = o.entry && o.entryLabel !== 'limit' ? [[X(n - 1), Y(last)], [xm, Y(e0 + (o.target - e0) * 0.35)], [xt, yT]] : [[X(n - 1), Y(last)], [xa + (xb - xa) * 0.15, yE], [xm, Y(e0 + (o.target - e0) * 0.3)], [xt, yT]];
    g += `<polyline fill="none" stroke="${C.text}" stroke-width="2.4" stroke-dasharray="7 6" points="${path.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}"/>`;
    const [px, py] = path[path.length - 2], ang = Math.atan2(yT - py, xt - px), ah = 12;
    g += `<polygon fill="${C.text}" points="${xt},${yT} ${xt - ah * Math.cos(ang - 0.45)},${yT - ah * Math.sin(ang - 0.45)} ${xt - ah * Math.cos(ang + 0.45)},${yT - ah * Math.sin(ang + 0.45)}"/>`;
    const rr = Math.abs(o.target - e0) / Math.abs(e0 - o.stop), tp = (o.target / e0 - 1) * 100, sl = (o.stop / e0 - 1) * 100;
    g += `<text x="${(xa + xb) / 2}" y="${(yE + yT) / 2 + 5}" text-anchor="middle" font-size="14" font-family="DejaVu Sans, Arial" font-weight="bold" fill="${C.target}">zysk ${Math.abs(tp).toFixed(1)}%</text>`;
    g += `<text x="${(xa + xb) / 2}" y="${(yE + yS) / 2 + 5}" text-anchor="middle" font-size="14" font-family="DejaVu Sans, Arial" font-weight="bold" fill="${C.stop}">ryzyko ${Math.abs(sl).toFixed(1)}%</text>`;
    g += `<text x="${(xa + xb) / 2}" y="${PT + PH + 22}" text-anchor="middle" font-size="13" font-family="DejaVu Sans, Arial" fill="${C.dim}">zysk : ryzyko = ${rr.toFixed(1)} : 1</text>`;
  }
  g += `<polyline fill="none" stroke="${C.ema}" stroke-width="2" opacity="0.8" points="${E.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`;
  const hline = (v, col, label, dash) => v > 0 ? `<line x1="${PL}" x2="${W - PR + 6}" y1="${Y(v)}" y2="${Y(v)}" stroke="${col}" stroke-width="2" ${dash ? 'stroke-dasharray="8 6"' : ''}/>
    <rect x="${W - PR + 8}" y="${Y(v) - 13}" width="${PR - 12}" height="26" rx="5" fill="${col}"/>
    <text x="${W - PR + 14}" y="${Y(v) + 5}" font-size="14" font-family="DejaVu Sans, Arial" font-weight="bold" fill="${C.bg}">${esc(label)} ${fmt(v)}</text>` : '';
  g += hline(o.target, C.target, 'cel', true) + hline(o.stop, C.stop, 'stop', true) + hline(o.lvl, C.lvl, 'wybicie', true) + (o.entry ? hline(o.entry, C.entry, o.entryLabel || 'wejście', !!o.entryLabel && o.entryLabel !== 'wejście') : '');
  const sideCol = o.side === 'LONG' ? C.up : C.down;
  const head = `<text x="${PL}" y="40" font-size="30" font-family="DejaVu Sans, Arial" font-weight="bold" fill="${C.text}">${esc(o.base)} <tspan fill="${sideCol}">${esc(o.side)}</tspan> <tspan font-size="20" fill="${C.dim}" font-weight="normal">· ${esc(o.status)}</tspan></text>
    <text x="${PL}" y="70" font-size="16" font-family="DejaVu Sans, Arial" fill="${C.dim}">${esc(o.sub || '')}</text>
    <text x="${W - PR}" y="40" text-anchor="end" font-size="16" font-family="DejaVu Sans, Arial" fill="${C.dim}">świece 1h (4 dni) · BingX · tradingjam</text>
    <text x="${PL}" y="${VT - 8}" font-size="13" font-family="DejaVu Sans, Arial" fill="${C.dim}">wolumen · linia pomarańczowa = EMA20</text>`;
  const foot = `<text x="${PL}" y="${H - 22}" font-size="15" font-family="DejaVu Sans, Arial" fill="${C.text}">${esc(o.checks || '')}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/>${head}${g}${foot}</svg>`;
}

function renderPng(svg) {
  try {
    let Resvg;
    try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { ({ Resvg } = require(require('path').join(__dirname, 'node_modules', '@resvg/resvg-js'))); }
    return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1400 }, font: { loadSystemFonts: true } }).render().asPng());
  } catch (e) { return null; }
}

module.exports = { chartSVG, renderPng };
