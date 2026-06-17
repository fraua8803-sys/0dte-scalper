/**
 * ICT Signal Bot — Server-Side
 * Läuft 24/7 auf Render, kein Browser nötig
 * Sendet Telegram Signale direkt vom Server
 */

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

// ── CONFIG ───────────────────────────────────────────────────────
const TD_KEY    = '536c483fcd0e496db29fe7220bcb7fd8';
const TG_TOKEN  = '8751954889:AAFEGArqp6T8lf4zS0C8P7A7zemcM4teU3A';
const TG_CHATS  = ['5499889900', '7264721144'];
const SL_PIPS   = 15;
const TP_PIPS   = 30;
const MIN_CONF  = 75;

const PAIRS = [
  {sym:'EURJPY', pip:2, dec:3, spread:1.5, priority:true},
  {sym:'GBPJPY', pip:2, dec:3, spread:2.5, priority:true},
  {sym:'USDJPY', pip:2, dec:3, spread:1.2, priority:true},
  {sym:'CADJPY', pip:2, dec:3, spread:2.0, priority:true},
  {sym:'USDCAD', pip:4, dec:5, spread:2.0, priority:false},
  {sym:'EURCAD', pip:4, dec:5, spread:2.5, priority:false},
  {sym:'EURGBP', pip:4, dec:5, spread:1.8, priority:false},
  {sym:'NZDUSD', pip:4, dec:5, spread:2.0, priority:false},
  {sym:'GBPCAD', pip:4, dec:5, spread:3.0, priority:false},
];

// ── STATE ────────────────────────────────────────────────────────
const state = {
  openSignals:  {},  // {sym: {dir, entry, conf, time}}
  lastTgSignal: {},  // {sym: timestamp}
  lastCandles:  {},  // {sym: candles[]}
  lastPrice:    {},  // {sym: price}
  signalCount:  0,
  lastNonJPY:   0,
};

// ── TELEGRAM ─────────────────────────────────────────────────────
async function tgSend(message) {
  let ok = false;
  for (const chatId of TG_CHATS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
        signal:  AbortSignal.timeout(8000),
      });
      const d = await r.json();
      if (d.ok) ok = true;
      else console.log(`[TG] Chat ${chatId} error: ${d.description}`);
    } catch (e) {
      console.log(`[TG] Chat ${chatId}: ${e.message}`);
    }
  }
  return ok;
}

// ── DATENQUELLEN ────────────────────────────────────────────────
// PRIMÄR:  TradingView WebSocket (tradingview-ws npm) — ~1min Delay, kostenlos
// FALLBACK: Twelve Data REST — 1min Kerzen zu 15min aggregiert

// TradingView Symbol-Format für Forex: FX:EURUSD
function tvSymbol(sym) {
  return `FX:${sym}`;
}

// Cache TradingView Connection (wiederverwendet für alle Pairs)
let tvConnection = null;
async function getTVConnection() {
  if (tvConnection) return tvConnection;
  try {
    const { connect } = await import('tradingview-ws');
    tvConnection = await connect();
    console.log('[TV] TradingView WebSocket verbunden');
    return tvConnection;
  } catch (e) {
    console.log(`[TV] Verbindung fehlgeschlagen: ${e.message}`);
    return null;
  }
}

// Kerzen von TradingView holen (15min Timeframe)
async function fetchCandlesTV(sym) {
  try {
    const conn = await getTVConnection();
    if (!conn) return null;
    const { getCandles } = await import('tradingview-ws');
    const results = await getCandles({
      connection: conn,
      symbols:   [tvSymbol(sym)],
      amount:    150,
      timeframe: 15,           // 15min Kerzen
    });
    const raw = results[0];
    if (!raw || raw.length < 10) return null;
    return raw.map(c => ({
      o: c.open, h: c.high, l: c.low, c: c.close,
    }));
  } catch (e) {
    console.log(`[TV] ${sym}: ${e.message}`);
    tvConnection = null;       // Reset bei Fehler → nächster Versuch reconnect
    return null;
  }
}

// Live-Preis von TradingView
async function fetchPriceTV(sym) {
  try {
    const conn = await getTVConnection();
    if (!conn) return null;
    const { getQuote } = await import('tradingview-ws');
    const quote = await getQuote({ connection: conn, symbol: tvSymbol(sym) });
    const p = parseFloat(quote?.price ?? quote?.lp);
    return (!isNaN(p) && p > 0) ? p : null;
  } catch (e) {
    return null;
  }
}

// Twelve Data Fallback: LIVE PRICE
async function fetchPriceTD(sym) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/price?symbol=${sym}&apikey=${TD_KEY}`,
      { signal: AbortSignal.timeout(6000) }
    );
    const d = await r.json();
    const p = parseFloat(d.price);
    return (!isNaN(p) && p > 0) ? p : null;
  } catch { return null; }
}

// Twelve Data Fallback: CANDLES (1min → 15min)
async function fetchCandlesTD(sym) {
  try {
    const url1 = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1min&outputsize=200&apikey=${TD_KEY}&format=JSON`;
    const r1 = await fetch(url1, { signal: AbortSignal.timeout(12000) });
    const d1 = await r1.json();
    if (d1.status !== 'error' && d1.values && d1.values.length >= 30) {
      const raw = d1.values.reverse().map(v => ({
        o: parseFloat(v.open), h: parseFloat(v.high),
        l: parseFloat(v.low),  c: parseFloat(v.close),
      }));
      const out = [];
      for (let i = 0; i + 14 < raw.length; i += 15) {
        const s = raw.slice(i, i + 15);
        out.push({ o: s[0].o, h: Math.max(...s.map(x => x.h)), l: Math.min(...s.map(x => x.l)), c: s[s.length-1].c });
      }
      if (out.length >= 8) return out;
    }
    const url5 = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=5min&outputsize=150&apikey=${TD_KEY}&format=JSON`;
    const r5 = await fetch(url5, { signal: AbortSignal.timeout(12000) });
    const d5 = await r5.json();
    if (d5.status !== 'error' && d5.values) {
      return d5.values.reverse().map(v => ({
        o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close),
      }));
    }
    return null;
  } catch (e) {
    console.log(`[TD] ${sym}: ${e.message}`);
    return null;
  }
}

// HAUPT-FUNKTIONEN: TV zuerst, Twelve Data als Fallback
async function fetchPrice(sym) {
  const tv = await fetchPriceTV(sym);
  if (tv) { console.log(`[Price] ${sym}: ${tv} (TradingView)`); return tv; }
  const td = await fetchPriceTD(sym);
  if (td) { console.log(`[Price] ${sym}: ${td} (TwelveData fallback)`); return td; }
  return null;
}

async function fetchCandles(sym) {
  const tv = await fetchCandlesTV(sym);
  if (tv) { console.log(`[Candles] ${sym}: ${tv.length} Kerzen (TradingView)`); return tv; }
  const td = await fetchCandlesTD(sym);
  if (td) { console.log(`[Candles] ${sym}: ${td.length} Kerzen (TwelveData fallback)`); return td; }
  return null;
}

// ── INDICATORS ───────────────────────────────────────────────────
function ema(d, p) {
  const k = 2 / (p + 1);
  const e = [d[0]];
  for (let i = 1; i < d.length; i++) e.push(d[i] * k + e[i-1] * (1 - k));
  return e;
}

function rsi(d, p = 14) {
  if (d.length < p + 1) return d.map(() => 50);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const x = d[i]-d[i-1]; x > 0 ? g += x : l -= x; }
  let ag = g/p, al = l/p;
  const r = [...Array(p).fill(null)];
  r.push(al === 0 ? 100 : 100 - 100/(1 + ag/al));
  for (let i = p+1; i < d.length; i++) {
    const x = d[i]-d[i-1];
    ag = (ag*(p-1) + (x > 0 ? x : 0)) / p;
    al = (al*(p-1) + (x < 0 ? -x : 0)) / p;
    r.push(al === 0 ? 100 : 100 - 100/(1 + ag/al));
  }
  return r;
}

// ── ICT ENGINE ───────────────────────────────────────────────────
function detectFVG(c) {
  const f = [];
  for (let i = 2; i < c.length; i++) {
    const a = c[i-2], b = c[i-1], x = c[i];
    if (x.l > a.h) f.push({ type:'bull', mid:(x.l+a.h)/2, idx:i, age:c.length-i });
    if (x.h < a.l) f.push({ type:'bear', mid:(a.l+x.h)/2, idx:i, age:c.length-i });
  }
  return f.filter(x => x.age < 40).slice(-6);
}

function detectOB(c) {
  const o = [];
  for (let i = 2; i < c.length-1; i++) {
    const x = c[i], n = c[i+1];
    if (x.c < x.o && n.c > n.o && (n.c-n.o) > (x.o-x.c)*1.3) o.push({ type:'bull', bottom:x.l, top:x.o, idx:i, age:c.length-i });
    if (x.c > x.o && n.c < n.o && (n.o-n.c) > (x.c-x.o)*1.3) o.push({ type:'bear', bottom:x.c, top:x.h, idx:i, age:c.length-i });
  }
  return o.filter(x => x.age < 60).slice(-4);
}

function detectLiq(c, n = 30) {
  const r = c.slice(-n), sh = [], sl = [];
  for (let i = 2; i < r.length-2; i++) {
    if (r[i].h > r[i-1].h && r[i].h > r[i-2].h && r[i].h > r[i+1].h && r[i].h > r[i+2].h) sh.push(r[i].h);
    if (r[i].l < r[i-1].l && r[i].l < r[i-2].l && r[i].l < r[i+1].l && r[i].l < r[i+2].l) sl.push(r[i].l);
  }
  // N-Perioden High/Low als primäre Liquidität (zuverlässiger als Swing-Points)
  // letzte 3 Kerzen ausgelassen, damit die Sweep-Kerze nicht ihr eigenes Level ist
  const w20 = c.slice(-23, -3);
  const w50 = c.slice(-53, -3);
  const hi20 = w20.length ? Math.max(...w20.map(x => x.h)) : null;
  const lo20 = w20.length ? Math.min(...w20.map(x => x.l)) : null;
  const hi50 = w50.length ? Math.max(...w50.map(x => x.h)) : null;
  const lo50 = w50.length ? Math.min(...w50.map(x => x.l)) : null;
  return { highs: sh.slice(-3), lows: sl.slice(-3), hi20, lo20, hi50, lo50 };
}

function detectSweep(c, liq) {
  // Sweep wird auf der letzten GESCHLOSSENEN Kerze geprüft (Bestätigung),
  // nicht auf der laufenden Live-Kerze. So entern wir nicht in den Docht selbst.
  const k = c[c.length-2];                       // geschlossene Kerze
  const rng = (k.h - k.l) || 1e-9;
  const upWick   = (k.h - Math.max(k.o, k.c)) / rng;  // Ablehnung von oben
  const downWick = (Math.min(k.o, k.c) - k.l) / rng;  // Ablehnung von unten

  const highLevels = [liq.hi20, liq.hi50, ...liq.highs].filter(v => v != null);
  const lowLevels  = [liq.lo20, liq.lo50, ...liq.lows ].filter(v => v != null);

  // Bearischer Sweep: Docht nimmt ein High, Close zurück darunter, starke obere Ablehnung
  for (const h of highLevels) {
    if (k.h > h && k.c < h && upWick >= 0.5) {
      return { dir:'bear', level:h, wick:Math.round(upWick*100),
               detail:`BSL Sweep @ ${h.toFixed(3)} (Wick ${Math.round(upWick*100)}%)` };
    }
  }
  // Bullischer Sweep: Docht nimmt ein Low, Close zurück darüber, starke untere Ablehnung
  for (const l of lowLevels) {
    if (k.l < l && k.c > l && downWick >= 0.5) {
      return { dir:'bull', level:l, wick:Math.round(downWick*100),
               detail:`SSL Sweep @ ${l.toFixed(3)} (Wick ${Math.round(downWick*100)}%)` };
    }
  }
  return null;
}

function detectMS(c) {
  const r = c.slice(-20), hs = r.map(x => x.h), ls = r.map(x => x.l);
  const hh = hs[hs.length-1] > Math.max(...hs.slice(0,-5));
  const hl = ls[ls.length-1] > Math.min(...ls.slice(0,-5));
  const lh = hs[hs.length-1] < Math.max(...hs.slice(0,-5));
  const ll = ls[ls.length-1] < Math.min(...ls.slice(0,-5));
  if (hh && hl) return { bias:'bull', detail:'HH+HL' };
  if (lh && ll) return { bias:'bear', detail:'LH+LL' };
  if (hh) return { bias:'bull', detail:'HH' };
  if (ll) return { bias:'bear', detail:'LL' };
  return { bias:'neutral', detail:'Ranging' };
}

function isKillZone() {
  const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
  const lon = (h === 7) || (h === 8 && m < 30);
  const ny  = (h === 12) || (h === 13 && m < 30);
  const tok = (h === 0) || (h === 1 && m < 30);
  return { active: lon||ny||tok, name: lon?'London KZ':ny?'NY KZ':tok?'Tokyo KZ':null };
}

// ══════════════════════════════════════════════════════════════
// A+ ICT ENTRY CHECKLIST — alle 5 Punkte PFLICHT für ein Signal
// ══════════════════════════════════════════════════════════════
// 1. LIQUIDITY GRAB  — Sweep eines Highs/Lows mit Wick-Ablehnung
// 2. MSS             — Market Structure Shift nach dem Sweep
// 3. DISCOUNT/PREMIUM— Long nur unter 50% des Ranges, Short drüber
// 4. PD ARRAY        — FVG oder OB als Einstiegszone
// 5. KILL ZONE       — London (07-09 UTC) oder NY (12-14 UTC)
// ══════════════════════════════════════════════════════════════

function detectMSS(candles, sweepDir) {
  // Market Structure Shift: nach einem bullischen Sweep muss der Preis
  // ein vorheriges Swing-High brechen (= bullisher MSS / BOS).
  // Nach bearischem Sweep muss er ein Swing-Low brechen.
  if (candles.length < 10) return false;
  const recent = candles.slice(-10);
  if (sweepDir === 'bull') {
    // Preis muss ein lokales Hoch der letzten 10 Kerzen nach oben brechen
    const prevHigh = Math.max(...recent.slice(0, -2).map(c => c.h));
    return recent[recent.length-1].h > prevHigh || recent[recent.length-2].h > prevHigh;
  } else {
    // Preis muss ein lokales Tief brechen
    const prevLow = Math.min(...recent.slice(0, -2).map(c => c.l));
    return recent[recent.length-1].l < prevLow || recent[recent.length-2].l < prevLow;
  }
}

function detectOTE(candles, sweepDir) {
  // Optimal Trade Entry: 62-79% Fibonacci Retracement des letzten Swings
  // Nach bullischem Sweep: letzter Swing = von letztem Low zu aktuellem High
  if (candles.length < 5) return { inOTE: false };
  const recent = candles.slice(-15);
  let swingHigh, swingLow;
  if (sweepDir === 'bull') {
    swingLow  = Math.min(...recent.map(c => c.l));
    swingHigh = Math.max(...recent.map(c => c.h));
    const range = swingHigh - swingLow;
    const ote62 = swingHigh - range * 0.62;
    const ote79 = swingHigh - range * 0.79;
    const price = recent[recent.length-1].c;
    return { inOTE: price >= ote79 && price <= ote62, ote62, ote79 };
  } else {
    swingLow  = Math.min(...recent.map(c => c.l));
    swingHigh = Math.max(...recent.map(c => c.h));
    const range = swingHigh - swingLow;
    const ote62 = swingLow + range * 0.62;
    const ote79 = swingLow + range * 0.79;
    const price = recent[recent.length-1].c;
    return { inOTE: price >= ote62 && price <= ote79, ote62, ote79 };
  }
}

function discountPremium(candles, sweepDir) {
  // 50% Fibonacci Filter: Long nur im Discount (unter 50%), Short nur im Premium
  if (candles.length < 20) return true; // kein Filter wenn zu wenig Daten
  const recent = candles.slice(-30);
  const high = Math.max(...recent.map(c => c.h));
  const low  = Math.min(...recent.map(c => c.l));
  const mid  = (high + low) / 2;
  const price = candles[candles.length-1].c;
  if (sweepDir === 'bull') return price < mid;   // Long nur im Discount
  else                     return price > mid;   // Short nur im Premium
}

function computeSignal(candles, pair) {
  if (candles.length < 30) return { dir:'wait', conf:0, detail:'Warmup' };

  const pip  = pair.pip === 2 ? 0.01 : 0.0001;
  const liq  = detectLiq(candles);
  const kz   = isKillZone();

  // ── STEP 1: KILL ZONE (Pflicht für A+ Setup) ─────────────────
  if (!kz.active) {
    return { dir:'wait', conf:0, detail:`Keine Kill Zone (${new Date().getUTCHours()}:${String(new Date().getUTCMinutes()).padStart(2,'0')} UTC)` };
  }

  // ── STEP 2: LIQUIDITY GRAB (Pflicht) ─────────────────────────
  const sweep = detectSweep(candles, liq);
  if (!sweep) {
    return { dir:'wait', conf:0, detail:'Kein Liquidity Grab' };
  }

  // ── STEP 3: MARKET STRUCTURE SHIFT (Pflicht) ─────────────────
  const mss = detectMSS(candles, sweep.dir);
  if (!mss) {
    return { dir:'wait', conf:10, detail:`Sweep OK · Warte auf MSS` };
  }

  // ── STEP 4: DISCOUNT / PREMIUM FILTER (Pflicht) ──────────────
  const inZone = discountPremium(candles, sweep.dir);
  if (!inZone) {
    return { dir:'wait', conf:20, detail:`Sweep+MSS OK · Preis ausserhalb ${sweep.dir==='bull'?'Discount':'Premium'}` };
  }

  // ── STEP 5: PD ARRAY — FVG oder OB (mindestens eines) ────────
  const fvgs  = detectFVG(candles);
  const obs   = detectOB(candles);
  const last  = candles[candles.length-1];
  const ote   = detectOTE(candles, sweep.dir);

  const nearFVG = fvgs.find(f =>
    Math.abs(last.c - f.mid) / pip < 20 &&
    ((sweep.dir === 'bull' && f.type === 'bull') || (sweep.dir === 'bear' && f.type === 'bear'))
  );
  const nearOB = obs.find(o =>
    Math.abs(last.c - (o.top+o.bottom)/2) / pip < 20 &&
    ((sweep.dir === 'bull' && o.type === 'bull') || (sweep.dir === 'bear' && o.type === 'bear'))
  );

  const hasPDArray = nearFVG || nearOB || ote.inOTE;
  if (!hasPDArray) {
    return { dir:'wait', conf:30, detail:`Sweep+MSS+Zone OK · Warte auf FVG/OB/OTE` };
  }

  // ── ALLE 5 PUNKTE ERFÜLLT → A+ SIGNAL ────────────────────────
  const direction = sweep.dir === 'bull' ? 'buy' : 'sell';
  const pdLabel   = nearFVG ? 'FVG' : nearOB ? 'OB' : 'OTE';

  // Konfidenz: Basis 75 + Boni für Qualität
  let conf = 75;
  const details = [`⚡${sweep.dir==='bull'?'SSL':'BSL'}`, 'MSS', pdLabel, kz.name];

  if (nearFVG && nearOB)  { conf += 10; details.push('+FVG+OB'); }  // beide = stärker
  if (ote.inOTE)          { conf += 8;  details.push('OTE✓'); }
  if (sweep.wick >= 70)   { conf += 7;  details.push(`Wick${sweep.wick}%`); }

  // EMA Trend-Bestätigung als Bonus
  const closes = candles.map(c => c.c);
  const ef = ema(closes, 8), es = ema(closes, 21);
  const n  = closes.length - 1;
  if (direction === 'buy'  && ef[n] > es[n]) { conf += 5; }
  if (direction === 'sell' && ef[n] < es[n]) { conf += 5; }

  conf = Math.min(conf, 100);

  return {
    dir:    direction,
    conf,
    detail: details.slice(0,5).join(' · '),
    sweep:  true,
    level:  sweep.level,
    pdArray: pdLabel,
    kz:     kz.name,
  };
}

// ── SIGNAL ALERTS ────────────────────────────────────────────────
async function processSignal(sig, pair, price) {
  const pip    = pair.pip === 2 ? 0.01 : 0.0001;
  const sp     = pair.spread * pip;
  const kz     = isKillZone();
  const open   = state.openSignals[pair.sym];
  const now    = new Date().toUTCString();

  // ── EXIT SIGNAL ──────────────────────────────────────────────
  if (open) {
    const shouldExit =
      (open.dir === 'buy'  && sig.dir === 'sell' && sig.conf >= 65) ||
      (open.dir === 'sell' && sig.dir === 'buy'  && sig.conf >= 65) ||
      (open.dir === 'buy'  && sig.dir === 'wait' && sig.conf < 40 && open.conf >= 75) ||
      (open.dir === 'sell' && sig.dir === 'wait' && sig.conf < 40 && open.conf >= 75);

    if (shouldExit) {
      const pipDiff = open.dir === 'buy'
        ? (price - open.entry) / pip
        : (open.entry - price) / pip;
      const reason = sig.dir !== 'wait' ? `Gegenrichtung ${sig.dir.toUpperCase()} ${sig.conf}%` : 'Setup gebrochen';

      const msg =
        `🚨 EXIT SIGNAL — JETZT SCHLIESSEN\n` +
        `${open.dir === 'buy' ? '🟢' : '🔴'} ${open.dir.toUpperCase()} <b>${pair.sym}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `Entry war: ${open.entry}\n` +
        `Jetzt: ${price.toFixed(pair.dec)}\n` +
        `Pips: ${pipDiff > 0 ? '+' : ''}${pipDiff.toFixed(1)}p\n` +
        `━━━━━━━━━━━━━━━\n` +
        `Grund: ${reason}\n` +
        `${now}`;

      const ok = await tgSend(msg);
      if (ok) {
        console.log(`[SIGNAL] EXIT ${pair.sym} — ${reason}`);
        state.openSignals[pair.sym] = null;
        state.signalCount++;
      }
    }
    return;
  }

  // ── ENTRY SIGNAL ─────────────────────────────────────────────
  if (sig.dir === 'wait' || sig.conf < MIN_CONF) return;

  const lastSent = state.lastTgSignal[pair.sym] || 0;
  if (Date.now() - lastSent < 30 * 60 * 1000) return; // 30min cooldown
  state.lastTgSignal[pair.sym] = Date.now();

  const entry = sig.dir === 'buy' ? +(price + sp/2).toFixed(pair.dec) : +(price - sp/2).toFixed(pair.dec);
  const sl    = sig.dir === 'buy' ? +(entry - SL_PIPS * pip).toFixed(pair.dec) : +(entry + SL_PIPS * pip).toFixed(pair.dec);
  const tp    = sig.dir === 'buy' ? +(entry + TP_PIPS * pip).toFixed(pair.dec) : +(entry - TP_PIPS * pip).toFixed(pair.dec);

  const msg =
    `${sig.dir === 'buy' ? '🟢 BUY' : '🔴 SELL'} ${sig.sweep ? '⚡ SWEEP ' : ''}<b>${pair.sym}</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `Entry: <b>${entry}</b>\n` +
    `SL: ${sl} (-${SL_PIPS}p)\n` +
    `TP: ${tp} (+${TP_PIPS}p)\n` +
    `Spread: ${pair.spread}p · R:R 1:${(TP_PIPS/SL_PIPS).toFixed(1)}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `Conf: ${sig.conf}% · ${sig.detail}\n` +
    `${kz.active ? `🎯 ${kz.name} aktiv\n` : ''}` +
    `${now}`;

  const ok = await tgSend(msg);
  if (ok) {
    state.openSignals[pair.sym] = { dir: sig.dir, entry, conf: sig.conf, time: Date.now() };
    state.signalCount++;
    console.log(`[SIGNAL] ${sig.dir.toUpperCase()} ${pair.sym} ${sig.conf}% — ${sig.detail}`);
  }
}

// ── MAIN SCAN LOOP ───────────────────────────────────────────────
let scanRound = 0;

async function scanPair(pair) {
  try {
    // Fetch realtime price
    const price = await fetchPrice(pair.sym);
    if (price) state.lastPrice[pair.sym] = price;

    // Refresh candles every 4 rounds (~60s for JPY, longer for non-JPY)
    const needsCandles = !state.lastCandles[pair.sym] ||
      (pair.priority && scanRound % 4 === 0) ||
      (!pair.priority && scanRound % 12 === 0);

    if (needsCandles) {
      const candles = await fetchCandles(pair.sym);
      if (candles) state.lastCandles[pair.sym] = candles;
    }

    const candles = state.lastCandles[pair.sym];
    if (!candles || !price) return;

    // Update last candle with live price
    const c = [...candles];
    c[c.length-1] = { ...c[c.length-1], c: price,
      h: Math.max(c[c.length-1].h, price),
      l: Math.min(c[c.length-1].l, price),
    };

    const sig = computeSignal(c, pair);
    await processSignal(sig, pair, price);

  } catch (e) {
    console.log(`[SCAN] ${pair.sym}: ${e.message}`);
  }
}

async function runScan() {
  scanRound++;
  console.log(`[SCAN] Round ${scanRound} — ${new Date().toUTCString()}`);

  // JPY pairs every round, non-JPY every 3rd round
  for (const pair of PAIRS) {
    if (!pair.priority && scanRound % 3 !== 0) continue;
    await scanPair(pair);
    await new Promise(r => setTimeout(r, 500)); // rate limit
  }
}

// ── API ENDPOINTS (for dashboard) ────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()) + 's',
    scanRound,
    signalCount: state.signalCount,
    openSignals: Object.entries(state.openSignals)
      .filter(([,v]) => v)
      .map(([sym, v]) => ({ sym, dir: v.dir, entry: v.entry, conf: v.conf })),
    prices: state.lastPrice,
  });
});

app.get('/api/signals', (req, res) => {
  const signals = {};
  for (const pair of PAIRS) {
    const candles = state.lastCandles[pair.sym];
    const price   = state.lastPrice[pair.sym];
    if (candles && price) {
      const c = [...candles];
      c[c.length-1] = { ...c[c.length-1], c: price };
      signals[pair.sym] = computeSignal(c, pair);
    } else {
      signals[pair.sym] = { dir:'wait', conf:0, detail:'Loading' };
    }
  }
  res.json({ signals, prices: state.lastPrice, openSignals: state.openSignals });
});

app.post('/api/notify', async (req, res) => {
  const { botToken, chatId, message } = req.body;
  if (!botToken || !chatId || !message)
    return res.status(400).json({ error: 'botToken, chatId, message required' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// IG API proxy endpoints (kept for compatibility)
const sessions = {};
function igBase(env) {
  return env === 'live' ? 'https://api.ig.com/gateway/deal' : 'https://demo-api.ig.com/gateway/deal';
}
async function igFetch(env, endpoint, method='GET', body=null, version='1') {
  const sess = sessions[env];
  const headers = { 'Content-Type':'application/json', 'Accept':'application/json', 'X-IG-API-KEY':sess?.apiKey||'', 'Version':version };
  if (sess?.cst) headers['CST'] = sess.cst;
  if (sess?.secToken) headers['X-SECURITY-TOKEN'] = sess.secToken;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(igBase(env) + endpoint, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}
app.post('/api/session', async (req, res) => {
  const { apiKey, username, password, env='demo' } = req.body;
  try {
    const igRes = await fetch(igBase(env)+'/session', {
      method:'POST', headers:{'Content-Type':'application/json','X-IG-API-KEY':apiKey,'Version':'2'},
      body: JSON.stringify({ identifier:username, password, encryptedPassword:false }),
    });
    const text = await igRes.text();
    let data; try { data = JSON.parse(text); } catch { data = {}; }
    if (!igRes.ok) return res.status(igRes.status).json({ error: data?.errorCode||'Login failed' });
    const cst = igRes.headers.get('CST'), secToken = igRes.headers.get('X-SECURITY-TOKEN');
    const accounts = data.accounts||[];
    const accountId = (accounts.find(a=>a.preferred)||accounts[0])?.accountId;
    sessions[env] = { apiKey, cst, secToken, accountId, expires: Date.now()+6*3600*1000 };
    res.json({ ok:true, accountId, env });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/accounts', async (req,res) => {
  const env=req.query.env||'demo';
  if(!sessions[env]) return res.status(401).json({error:'Not logged in'});
  const {status,data}=await igFetch(env,'/accounts');
  res.status(status).json(data);
});
app.post('/api/positions', async (req,res) => {
  const {env='demo',epic,direction,size,stopDistance,limitDistance,currencyCode='EUR'}=req.body;
  if(!sessions[env]) return res.status(401).json({error:'Not logged in'});
  const order={epic,expiry:'-',direction,size,orderType:'MARKET',timeInForce:'FILL_OR_KILL',guaranteedStop:false,currencyCode,...(stopDistance?{stopDistance,trailingStop:false}:{}),...(limitDistance?{limitDistance}:{})};
  const {status,data}=await igFetch(env,'/positions/otc','POST',order,'2');
  res.status(status).json(data);
});
app.get('/api/confirms/:ref', async (req,res) => {
  const env=req.query.env||'demo';
  if(!sessions[env]) return res.status(401).json({error:'Not logged in'});
  const {status,data}=await igFetch(env,`/confirms/${req.params.ref}`);
  res.status(status).json(data);
});

// ── SELF PING ────────────────────────────────────────────────────
function startSelfPing() {
  const domain = process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
  setInterval(async () => {
    try { await fetch(`${domain}/api/status`, { signal: AbortSignal.timeout(5000) }); }
    catch(e) { console.log(`[Ping] ${e.message}`); }
  }, 4 * 60 * 1000);
  console.log(`[Ping] Self-ping active`);
}

// ── MIDNIGHT RESET ───────────────────────────────────────────────
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  setTimeout(() => {
    state.lastTgSignal = {};
    state.openSignals  = {};
    console.log('[RESET] Daily reset — signals cleared');
    tgSend('🌅 Neuer Tag — Signal Bot zurückgesetzt');
    scheduleMidnightReset();
  }, midnight - now);
}

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ ICT Signal Bot running on port ${PORT}`);
  console.log(`   Scanning ${PAIRS.length} pairs every 15s`);
  console.log(`   Telegram: ${TG_CHATS.length} recipients\n`);

  startSelfPing();
  scheduleMidnightReset();

  // Start scan after 3 seconds
  setTimeout(async () => {
    await tgSend('🚀 ICT Signal Bot gestartet\n24/7 Server-Modus aktiv\nAutomatische Alerts bei Conf ≥75%');
    runScan();
    setInterval(runScan, 15 * 1000); // every 15 seconds
  }, 3000);
});
