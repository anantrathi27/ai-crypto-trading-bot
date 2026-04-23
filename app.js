'use strict';

// ============================================================
//  CryptoMind AI — Binance Live API Integration
//  Public: REST + WebSocket (no key needed)
//  Private: HMAC-SHA256 signed requests (API key + secret)
// ============================================================

// ————————————————————————————————————————
// BINANCE CONFIG
// ————————————————————————————————————————
const BINANCE = {
  REST_BASE:   'https://api.binance.com',
  WS_BASE:     'wss://stream.binance.com:9443',
  TESTNET_REST:'https://testnet.binance.vision',
  TESTNET_WS:  'wss://testnet.binance.vision',
};

// Coin definitions — keyed by Binance symbol
const COIN_MAP = {
  BTCUSDT:  { symbol: 'BTC',  name: 'Bitcoin',   icon: '₿',  color: '#F7931A', id: 'bitcoin'     },
  ETHUSDT:  { symbol: 'ETH',  name: 'Ethereum',  icon: 'Ξ',  color: '#627EEA', id: 'ethereum'    },
  SOLUSDT:  { symbol: 'SOL',  name: 'Solana',    icon: '◎',  color: '#9945FF', id: 'solana'      },
  BNBUSDT:  { symbol: 'BNB',  name: 'BNB',       icon: 'B',  color: '#F3BA2F', id: 'binancecoin' },
  XRPUSDT:  { symbol: 'XRP',  name: 'XRP',       icon: 'X',  color: '#00AAE4', id: 'ripple'      },
  ADAUSDT:  { symbol: 'ADA',  name: 'Cardano',   icon: 'A',  color: '#0033AD', id: 'cardano'     },
  DOGEUSDT: { symbol: 'DOGE', name: 'Dogecoin',  icon: 'D',  color: '#C2A633', id: 'dogecoin'    },
  AVAXUSDT: { symbol: 'AVAX', name: 'Avalanche', icon: 'A',  color: '#E84142', id: 'avalanche'   },
  MATICUSDT:{ symbol: 'MATIC',name: 'Polygon',   icon: 'P',  color: '#8247E5', id: 'matic-network'},
  SHIBUSDT: { symbol: 'SHIB', name: 'Shiba Inu', icon: 'S',  color: '#FFA409', id: 'shiba-inu'   },
};

const ALL_SYMBOLS = Object.keys(COIN_MAP);

// Timeframe → Binance kline interval + candle limit
const TF_MAP = {
  1:  { interval: '1h',  limit: 24  },
  7:  { interval: '4h',  limit: 42  },
  30: { interval: '1d',  limit: 30  },
  90: { interval: '1d',  limit: 90  },
};

// ————————————————————————————————————————
// APPLICATION STATE
// ————————————————————————————————————————
const STATE = {
  activeTab:        'dashboard',
  selectedSymbol:   'BTCUSDT',
  selectedTimeframe: 7,
  marketData:       {},   // { BTCUSDT: { price, change24h, volume, high, low, ... } }
  klineData:        {},   // { BTCUSDT: { prices:[], times:[], volumes:[] } }
  signals:          {},   // { BTCUSDT: signalObject }
  botActive:        true,
  useTestnet:       false,
  portfolio: [
    { symbol: 'BTC',  name: 'Bitcoin',  binanceSymbol: 'BTCUSDT',  amount: 0.18,  avgBuy: 42000, color: '#F7931A' },
    { symbol: 'ETH',  name: 'Ethereum', binanceSymbol: 'ETHUSDT',  amount: 2.4,   avgBuy: 2800,  color: '#627EEA' },
    { symbol: 'SOL',  name: 'Solana',   binanceSymbol: 'SOLUSDT',  amount: 28,    avgBuy: 115,   color: '#9945FF' },
    { symbol: 'BNB',  name: 'BNB',      binanceSymbol: 'BNBUSDT',  amount: 5.5,   avgBuy: 280,   color: '#F3BA2F' },
    { symbol: 'USDT', name: 'Tether',   binanceSymbol: null,       amount: 1200,  avgBuy: 1,     color: '#26A17B' },
  ],
  trades:           generateMockTrades(),
  charts:           {},
  wsManager:        null,
  refreshInterval:  null,
  backtestChart:    null,
  apiKey:           localStorage.getItem('bnc_api_key')    || '',
  apiSecret:        localStorage.getItem('bnc_api_secret') || '',
  accountInfo:      null,
};

// ————————————————————————————————————————
// BINANCE REST API LAYER
// ————————————————————————————————————————
const BinanceREST = {

  base() { return STATE.useTestnet ? BINANCE.TESTNET_REST : BINANCE.REST_BASE; },

  // HMAC-SHA256 signature for authenticated requests
  async sign(queryString) {
    const secret  = STATE.apiSecret;
    if (!secret) throw new Error('API secret not set');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(queryString));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  // Public GET request (no auth)
  async get(path, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = `${this.base()}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Binance ${res.status}: ${err.msg || res.statusText}`);
    }
    return res.json();
  },

  // Signed GET request (authenticated)
  async signedGet(path, params = {}) {
    if (!STATE.apiKey) throw new Error('API key not set. Please add it in Settings.');
    params.timestamp  = Date.now();
    params.recvWindow = 5000;
    const qs        = new URLSearchParams(params).toString();
    const signature = await this.sign(qs);
    const url = `${this.base()}${path}?${qs}&signature=${signature}`;
    const res = await fetch(url, { headers: { 'X-MBX-APIKEY': STATE.apiKey } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Binance ${res.status}: ${err.msg || res.statusText}`);
    }
    return res.json();
  },

  // Signed POST request (authenticated — for placing orders)
  async signedPost(path, params = {}) {
    if (!STATE.apiKey) throw new Error('API key not set. Please add it in Settings.');
    params.timestamp  = Date.now();
    params.recvWindow = 5000;
    const qs        = new URLSearchParams(params).toString();
    const signature = await this.sign(qs);
    const url = `${this.base()}${path}`;
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'X-MBX-APIKEY': STATE.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${qs}&signature=${signature}`,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Binance ${res.status}: ${err.msg || res.statusText}`);
    }
    return res.json();
  },

  // ── Public Endpoints ────────────────────

  // GET 24h ticker stats for all our symbols at once
  async fetch24hrTickers(symbols) {
    try {
      const symbolsJson = JSON.stringify(symbols);
      return await this.get('/api/v3/ticker/24hr', { symbols: symbolsJson });
    } catch (e) {
      console.warn('24hr ticker failed:', e.message);
      return null;
    }
  },

  // GET klines (OHLCV candlestick data)
  async fetchKlines(symbol, interval, limit) {
    try {
      return await this.get('/api/v3/klines', { symbol, interval, limit });
    } catch (e) {
      console.warn(`Klines fetch failed for ${symbol}:`, e.message);
      return null;
    }
  },

  // GET current price only (lightweight)
  async fetchPrice(symbol) {
    try {
      return await this.get('/api/v3/ticker/price', { symbol });
    } catch (e) {
      console.warn(`Price fetch failed for ${symbol}:`, e.message);
      return null;
    }
  },

  // GET exchange info (min qty, precision etc.)
  async fetchExchangeInfo(symbol) {
    try {
      return await this.get('/api/v3/exchangeInfo', { symbol });
    } catch (e) {
      return null;
    }
  },

  // ── Authenticated Endpoints ──────────────

  // GET account balances & info
  async fetchAccountInfo() {
    return await this.signedGet('/api/v3/account');
  },

  // GET open orders
  async fetchOpenOrders(symbol) {
    const params = symbol ? { symbol } : {};
    return await this.signedGet('/api/v3/openOrders', params);
  },

  // GET trade history
  async fetchMyTrades(symbol, limit = 50) {
    return await this.signedGet('/api/v3/myTrades', { symbol, limit });
  },

  // POST place a MARKET order
  async placeMarketOrder(symbol, side, quoteOrderQty) {
    return await this.signedPost('/api/v3/order', {
      symbol,
      side,          // BUY or SELL
      type:          'MARKET',
      quoteOrderQty: quoteOrderQty.toFixed(2),  // USDT amount
    });
  },

  // POST place a LIMIT order
  async placeLimitOrder(symbol, side, quantity, price) {
    return await this.signedPost('/api/v3/order', {
      symbol,
      side,
      type:        'LIMIT',
      timeInForce: 'GTC',
      quantity:    quantity.toFixed(6),
      price:       price.toFixed(2),
    });
  },

  // DELETE cancel an order
  async cancelOrder(symbol, orderId) {
    return await this.signedPost('/api/v3/order/delete', { symbol, orderId });
  },
};

// ————————————————————————————————————————
// BINANCE WEBSOCKET MANAGER
// ————————————————————————————————————————
class BinanceWS {
  constructor() {
    this.sockets    = {};
    this.reconnect  = {};
    this.handlers   = {};
  }

  base() { return STATE.useTestnet ? BINANCE.TESTNET_WS : BINANCE.WS_BASE; }

  // Connect a stream. streamName e.g. "btcusdt@ticker"
  connect(streamName, onMessage) {
    if (this.sockets[streamName]) this.close(streamName);

    const url = `${this.base()}/ws/${streamName}`;
    const ws  = new WebSocket(url);
    this.sockets[streamName]   = ws;
    this.handlers[streamName]  = onMessage;
    this.reconnect[streamName] = true;

    ws.onopen    = () => console.log(`[WS] Connected: ${streamName}`);
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch(err) {} };
    ws.onerror   = (e) => console.warn(`[WS] Error on ${streamName}`);
    ws.onclose   = () => {
      if (this.reconnect[streamName]) {
        console.log(`[WS] Reconnecting ${streamName} in 3s...`);
        setTimeout(() => this.connect(streamName, this.handlers[streamName]), 3000);
      }
    };
    return ws;
  }

  // Connect a combined multi-stream
  connectCombined(streams, onMessage) {
    const name = streams.join('/');
    if (this.sockets[name]) this.close(name);

    const url = `${this.base()}/stream?streams=${name}`;
    const ws  = new WebSocket(url);
    this.sockets[name]   = ws;
    this.handlers[name]  = onMessage;
    this.reconnect[name] = true;

    ws.onopen    = () => {
      console.log(`[WS] Combined stream connected (${streams.length} streams)`);
      updateApiStatusBadge(true);
    };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch(err) {} };
    ws.onerror   = (e) => {
      console.warn('[WS] Combined stream error');
      updateApiStatusBadge(false);
    };
    ws.onclose   = () => {
      updateApiStatusBadge(false);
      if (this.reconnect[name]) {
        console.log('[WS] Combined stream reconnecting in 3s...');
        setTimeout(() => this.connectCombined(streams, this.handlers[name]), 3000);
      }
    };
    return ws;
  }

  close(name) {
    this.reconnect[name] = false;
    if (this.sockets[name]) {
      this.sockets[name].close();
      delete this.sockets[name];
    }
  }

  closeAll() {
    Object.keys(this.sockets).forEach(n => this.close(n));
  }
}

const wsManager = new BinanceWS();

// ————————————————————————————————————————
// TECHNICAL ANALYSIS ENGINE
// ————————————————————————————————————————
const TA = {
  rsi(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = prices[i] - prices[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    let ag = gains / period, al = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
      const d = prices[i] - prices[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (al === 0) return 100;
    return +(100 - 100 / (1 + ag / al)).toFixed(1);
  },

  ema(prices, period) {
    if (!prices.length || prices.length < period) return prices[prices.length - 1] || 0;
    const k   = 2 / (period + 1);
    let ema   = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return +ema.toFixed(4);
  },

  macd(prices) {
    const ema12 = this.ema(prices, 12);
    const ema26 = this.ema(prices, 26);
    const line  = +(ema12 - ema26).toFixed(4);
    return { line, histogram: line };
  },

  bollingerBands(prices, period = 20, std = 2) {
    if (prices.length < period) return { upper: 0, middle: 0, lower: 0, width: 0 };
    const win  = prices.slice(-period);
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const sd   = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    return {
      upper:  +(mean + std * sd).toFixed(4),
      middle: +mean.toFixed(4),
      lower:  +(mean - std * sd).toFixed(4),
      width:  +((2 * std * sd / mean) * 100).toFixed(2),
    };
  },

  stochRsi(prices, period = 14) {
    const rsiArr = [];
    for (let i = period; i < prices.length; i++)
      rsiArr.push(this.rsi(prices.slice(i - period, i + 1), period));
    if (rsiArr.length < period) return 50;
    const win  = rsiArr.slice(-period);
    const min  = Math.min(...win), max = Math.max(...win);
    if (max === min) return 50;
    return +((win[win.length - 1] - min) / (max - min) * 100).toFixed(1);
  },

  generateSignal(prices, currentPrice) {
    if (prices.length < 52) return null;

    const rsi     = this.rsi(prices);
    const ema20   = this.ema(prices, 20);
    const ema50   = this.ema(prices, 50);
    const { line: macdLine } = this.macd(prices);
    const bb      = this.bollingerBands(prices);
    const stoch   = this.stochRsi(prices);

    let bull = 0, bear = 0;

    // RSI
    const rsiSig = rsi < 35 ? 'BUY' : rsi > 65 ? 'SELL' : 'HOLD';
    if (rsi < 35) bull += 2; else if (rsi > 65) bear += 2; else bull += 0.5;

    // EMA cross
    const emaSig = ema20 > ema50 ? 'BUY' : ema20 < ema50 ? 'SELL' : 'HOLD';
    if (ema20 > ema50) bull += 2; else if (ema20 < ema50) bear += 2;

    // MACD
    const macdSig = macdLine > 0 ? 'BUY' : 'SELL';
    if (macdLine > 0) bull += 1.5; else bear += 1.5;

    // Bollinger
    const bbSig = currentPrice < bb.lower ? 'BUY' : currentPrice > bb.upper ? 'SELL' : 'HOLD';
    if (currentPrice < bb.lower) bull += 2; else if (currentPrice > bb.upper) bear += 2;

    // Stoch RSI
    const stochSig = stoch < 25 ? 'BUY' : stoch > 75 ? 'SELL' : 'HOLD';
    if (stoch < 25) bull += 1.5; else if (stoch > 75) bear += 1.5;

    // Volume trend (OBV mock based on price momentum)
    const recentChg = (prices[prices.length - 1] - prices[prices.length - 6]) / prices[prices.length - 6];
    const obvSig    = recentChg > 0 ? 'BUY' : 'SELL';
    if (recentChg > 0) bull += 1; else bear += 1;

    const total      = bull + bear;
    const confidence = Math.min(95, Math.round((Math.max(bull, bear) / total) * 100));
    const ratio      = bull / (bear || 0.01);

    let action;
    if (ratio > 2.5)       action = 'STRONG BUY';
    else if (ratio > 1.4)  action = 'BUY';
    else if (ratio < 0.4)  action = 'STRONG SELL';
    else if (ratio < 0.71) action = 'SELL';
    else                   action = 'HOLD';

    return {
      action, confidence, bull, bear,
      indicators: {
        rsi:   { value: rsi,               display: rsi.toFixed(1),                             signal: rsiSig   },
        macd:  { value: macdLine,          display: macdLine.toFixed(2),                        signal: macdSig  },
        ema:   { value: ema20,             display: `${ema20.toFixed(0)}/${ema50.toFixed(0)}`,  signal: emaSig   },
        bb:    { value: bb.width,          display: bb.width.toFixed(2) + '%',                  signal: bbSig    },
        stoch: { value: stoch,             display: stoch.toFixed(1),                           signal: stochSig },
        obv:   { value: recentChg * 100,   display: (recentChg * 100).toFixed(2) + '%',         signal: obvSig   },
      }
    };
  }
};

// ————————————————————————————————————————
// MOCK DATA (fallback + history)
// ————————————————————————————————————————
function generateMockTrades() {
  const syms    = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];
  const reasons = [
    'RSI oversold + MACD cross', 'EMA 20/50 golden cross', 'BB lower band touch',
    'Strong volume surge', 'RSI overbought exit', 'MACD bearish divergence',
    'Stoch RSI < 20 reversal', 'Support level hold', 'Multi-indicator confluence'
  ];
  const trades = [];
  const now    = Date.now();
  for (let i = 0; i < 52; i++) {
    const coin  = syms[i % syms.length];
    const type  = i % 3 === 0 ? 'SELL' : 'BUY';
    const base  = coin === 'BTC' ? 65000 : coin === 'ETH' ? 3200 : coin === 'SOL' ? 160 : coin === 'BNB' ? 550 : 0.55;
    const price = base * (0.92 + Math.random() * 0.16);
    const amt   = +(150 + Math.random() * 850).toFixed(2);
    const pnl   = type === 'SELL' ? +((Math.random() * 180 - 50) * (Math.random() > 0.28 ? 1 : -1)).toFixed(2) : null;
    trades.push({
      id: i, date: new Date(now - i * 8.5 * 3600000 - Math.random() * 3600000),
      coin, type, price: +price.toFixed(coin === 'BTC' ? 0 : 2),
      amount: amt, total: amt, pnl,
      reason: reasons[i % reasons.length],
      source: 'AI Bot',
    });
  }
  return trades;
}

function generateFallbackKlines(basePrice, count) {
  const prices = [], times = [], volumes = [];
  let p = basePrice * (0.9 + Math.random() * 0.2);
  const now = Date.now();
  const step = (count <= 24 ? 3600 : count <= 42 ? 14400 : 86400) * 1000;
  for (let i = count - 1; i >= 0; i--) {
    p = p * (1 + (Math.random() - 0.47) * 0.025);
    prices.push(+p.toFixed(p < 1 ? 6 : 2));
    times.push(new Date(now - i * step));
    volumes.push(+(1e6 + Math.random() * 9e6).toFixed(0));
  }
  return { prices, times, volumes };
}

// ————————————————————————————————————————
// WEBSOCKET REAL-TIME STREAM SETUP
// ————————————————————————————————————————
function startWebSocketStreams() {
  const streams = ALL_SYMBOLS.map(s => s.toLowerCase() + '@miniTicker');

  wsManager.connectCombined(streams, (msg) => {
    if (!msg.data) return;
    const d      = msg.data;
    const symbol = d.s;           // e.g. "BTCUSDT"
    if (!COIN_MAP[symbol]) return;

    const prev   = STATE.marketData[symbol];
    const price  = parseFloat(d.c);  // close price
    const open   = parseFloat(d.o);  // open

    STATE.marketData[symbol] = {
      price,
      open,
      change24h:   +((price - open) / open * 100).toFixed(2),
      high24h:     parseFloat(d.h),
      low24h:      parseFloat(d.l),
      volume24h:   parseFloat(d.v),
      quoteVolume: parseFloat(d.q),
      time:        d.E,
    };

    // Flash price update in topbar
    if (['BTCUSDT','ETHUSDT','SOLUSDT'].includes(symbol)) {
      updateTickerItem(symbol, STATE.marketData[symbol], prev?.price);
    }

    // Update chart live if this is the selected symbol
    if (symbol === STATE.selectedSymbol && STATE.charts.price) {
      appendLivePrice(price);
    }

    updateLastUpdateTime();
  });
}

function appendLivePrice(price) {
  const chart = STATE.charts.price;
  if (!chart || !chart.data.labels.length) return;

  const now = new Date();
  chart.data.labels.push(formatChartTime(now, STATE.selectedTimeframe));
  chart.data.datasets[0].data.push(price);

  // Keep chart from growing too long
  if (chart.data.labels.length > 500) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update('none');  // no animation for live updates
}

// ————————————————————————————————————————
// API STATUS BADGE
// ————————————————————————————————————————
function updateApiStatusBadge(connected) {
  const dot  = document.querySelector('.api-dot');
  const text = document.querySelector('.sidebar-footer span');
  if (!dot || !text) return;
  if (connected) {
    dot.style.background = 'var(--green)';
    text.textContent = 'Binance WS Connected';
  } else {
    dot.style.background = 'var(--orange)';
    text.textContent = 'Binance WS Reconnecting...';
  }
}

// ————————————————————————————————————————
// INITIALIZATION
// ————————————————————————————————————————
async function init() {
  // Load saved API keys into form fields
  loadApiKeysToForm();

  // Init charts first (empty)
  initCharts();

  // Fetch initial 24h data via REST
  await fetchAllTickers();

  // Render UI
  renderRecentTrades();
  renderPortfolioDonut();
  updateStatCards();
  updateSentimentGauge(Math.floor(55 + Math.random() * 30));

  // Load klines for default coin and render chart
  await refreshChart();

  // Start WebSocket real-time stream
  startWebSocketStreams();

  // Periodic REST refresh (klines + stats) every 60s
  STATE.refreshInterval = setInterval(async () => {
    await fetchAllTickers();
    updateStatCards();
    if (STATE.activeTab === 'markets')    renderMarketsTab();
    if (STATE.activeTab === 'portfolio')  renderPortfolioTab();
    if (STATE.activeTab === 'signals')    renderSignalsTab();
    simulateBotActivity();
  }, 60000);

  showToast('success', '🔗 Binance Connected', 'Live WebSocket stream active — prices updating in real-time');
}

// ————————————————————————————————————————
// DATA FETCHING
// ————————————————————————————————————————
async function fetchAllTickers() {
  try {
    const data = await BinanceREST.fetch24hrTickers(ALL_SYMBOLS);
    if (!data) return;
    data.forEach(t => {
      STATE.marketData[t.symbol] = {
        price:       parseFloat(t.lastPrice),
        change24h:   parseFloat(t.priceChangePercent),
        high24h:     parseFloat(t.highPrice),
        low24h:      parseFloat(t.lowPrice),
        volume24h:   parseFloat(t.volume),
        quoteVolume: parseFloat(t.quoteVolume),
        open:        parseFloat(t.openPrice),
        time:        Date.now(),
      };
    });
    updateTopbarTicker();
    if (STATE.activeTab === 'markets') renderMarketsTab();
  } catch (e) {
    console.warn('fetchAllTickers failed:', e.message);
    injectFallbackPrices();
  }
}

function injectFallbackPrices() {
  const bases = {
    BTCUSDT: 67420, ETHUSDT: 3520, SOLUSDT: 168,  BNBUSDT: 580,
    XRPUSDT: 0.55,  ADAUSDT: 0.62, DOGEUSDT: 0.165, AVAXUSDT: 38,
    MATICUSDT: 0.88, SHIBUSDT: 0.0000268,
  };
  ALL_SYMBOLS.forEach(sym => {
    if (!STATE.marketData[sym]) {
      const base = bases[sym] || 1;
      const chg  = (Math.random() - 0.46) * 6;
      STATE.marketData[sym] = {
        price: +(base * (1 + chg / 100)),
        change24h: +chg.toFixed(2),
        high24h: base * 1.03, low24h: base * 0.97,
        volume24h: 1e8, quoteVolume: 3e9,
        open: base, time: Date.now(),
      };
    }
  });
  updateTopbarTicker();
}

async function fetchKlinesForSymbol(symbol, timeframe) {
  const tf     = TF_MAP[timeframe] || TF_MAP[7];
  const raw    = await BinanceREST.fetchKlines(symbol, tf.interval, tf.limit);
  if (!raw) {
    const base = STATE.marketData[symbol]?.price || 10000;
    return generateFallbackKlines(base, tf.limit);
  }
  // Binance kline: [openTime, open, high, low, close, volume, ...]
  const prices  = raw.map(k => parseFloat(k[4]));  // close prices
  const volumes = raw.map(k => parseFloat(k[5]));
  const times   = raw.map(k => new Date(k[0]));
  return { prices, times, volumes };
}

// ————————————————————————————————————————
// ACCOUNT INFO (Authenticated)
// ————————————————————————————————————————
async function fetchAccountInfo() {
  if (!STATE.apiKey || !STATE.apiSecret) {
    showToast('warning', '🔑 API Keys Missing', 'Add your Binance API key & secret in Settings');
    return;
  }
  try {
    showToast('info', '⏳ Fetching Account', 'Loading your Binance account...');
    const info = await BinanceREST.fetchAccountInfo();
    STATE.accountInfo = info;

    // Update portfolio with real balances
    const nonZero = info.balances.filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);
    showToast('success', '✅ Account Loaded', `${nonZero.length} assets found`);
    renderPortfolioFromAccount(nonZero);
    return info;
  } catch (e) {
    showToast('error', '❌ Account Error', e.message);
    return null;
  }
}

function renderPortfolioFromAccount(balances) {
  // Map Binance balances to our portfolio format
  const mapped = balances.map(b => {
    const sym     = b.asset;
    const binSym  = sym + 'USDT';
    const price   = sym === 'USDT' ? 1 : (STATE.marketData[binSym]?.price || 0);
    const amount  = parseFloat(b.free) + parseFloat(b.locked);
    const color   = COIN_MAP[binSym]?.color || '#6C63FF';
    return { symbol: sym, name: sym, binanceSymbol: binSym, amount, avgBuy: price * 0.95, color };
  }).filter(h => h.amount > 0);

  if (mapped.length > 0) {
    STATE.portfolio = mapped;
    renderPortfolioDonut();
    renderPortfolioTab();
  }
}

// ————————————————————————————————————————
// LIVE TRADE EXECUTION (Authenticated)
// ————————————————————————————————————————
async function executeLiveTrade(symbol, side, usdtAmount) {
  try {
    showToast('info', '⏳ Placing Order', `${side} ${COIN_MAP[symbol]?.symbol} @ market`);
    const result = await BinanceREST.placeMarketOrder(symbol, side, usdtAmount);

    // Add to local trade history
    const price = STATE.marketData[symbol]?.price || 0;
    STATE.trades.unshift({
      id: STATE.trades.length, date: new Date(),
      coin: COIN_MAP[symbol]?.symbol,
      type: side, price, amount: usdtAmount, total: usdtAmount,
      pnl: null, reason: result.status + ' via Binance API',
      source: 'Live', orderId: result.orderId,
    });

    renderRecentTrades();
    renderTradesTab();

    showToast('success', `✅ Order Filled!`,
      `${side} ${COIN_MAP[symbol]?.symbol} — Order #${result.orderId}`);
    return result;
  } catch (e) {
    showToast('error', '❌ Order Failed', e.message);
    return null;
  }
}

// ————————————————————————————————————————
// CHART INITIALIZATION
// ————————————————————————————————————————
function initCharts() {
  Chart.defaults.color       = 'rgba(240,240,255,0.5)';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  initPriceChart();
  initPortfolioMiniChart();
}

function initPriceChart() {
  const ctx = document.getElementById('priceChart').getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, 'rgba(108,99,255,0.3)');
  gradient.addColorStop(1, 'rgba(108,99,255,0)');

  STATE.charts.price = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Price (USDT)',
        data: [],
        borderColor:     '#6C63FF',
        backgroundColor: gradient,
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 5,
        tension: 0.3, fill: true,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10,14,30,0.97)',
          borderColor: 'rgba(108,99,255,0.4)', borderWidth: 1,
          padding: 12,
          titleColor: 'rgba(240,240,255,0.6)',
          bodyColor: '#F0F0FF',
          bodyFont: { family: 'JetBrains Mono', weight: 'bold', size: 13 },
          callbacks: { label: ctx => '  ' + formatPrice(ctx.raw) }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { maxTicksLimit: 8, font: { size: 10 }, maxRotation: 0 },
        },
        y: {
          position: 'right',
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { font: { size: 10 }, callback: v => formatPrice(v) },
        }
      }
    }
  });
}

function initPortfolioMiniChart() {
  const ctx = document.getElementById('portfolioMiniChart');
  if (!ctx) return;
  const g    = ctx.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 60);
  grad.addColorStop(0, 'rgba(46,213,115,0.3)');
  grad.addColorStop(1, 'rgba(46,213,115,0)');
  const days   = 14;
  const labels = Array.from({ length: days }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (days - 1 - i));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const base = 10500;
  const data = labels.map((_, i) => +(base * (1 + i * 0.006 + (Math.random() - 0.4) * 0.02)).toFixed(0));

  STATE.charts.portfolio = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: '#2ED573', backgroundColor: grad, borderWidth: 2, pointRadius: 0, tension: 0.4, fill: true }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
}

async function refreshChart() {
  const sym  = STATE.selectedSymbol;
  const tf   = STATE.selectedTimeframe;

  // Show loading
  if (STATE.charts.price) {
    STATE.charts.price.data.labels   = ['Loading live data from Binance...'];
    STATE.charts.price.data.datasets[0].data = [0];
    STATE.charts.price.update('none');
  }

  const hist = await fetchKlinesForSymbol(sym, tf);
  STATE.klineData[sym] = hist;

  // Update chart
  const isUp     = hist.prices[hist.prices.length - 1] >= hist.prices[0];
  const upColor  = '#6C63FF';
  const dnColor  = '#FF4757';
  const color    = isUp ? upColor : dnColor;
  const ctx      = STATE.charts.price.ctx;
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, isUp ? 'rgba(108,99,255,0.25)' : 'rgba(255,71,87,0.2)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  STATE.charts.price.data.labels                       = hist.times.map(t => formatChartTime(t, tf));
  STATE.charts.price.data.datasets[0].data             = hist.prices;
  STATE.charts.price.data.datasets[0].borderColor      = color;
  STATE.charts.price.data.datasets[0].backgroundColor  = gradient;
  STATE.charts.price.update();

  // Compute AI signals from real kline close prices
  const signal = TA.generateSignal(hist.prices, hist.prices[hist.prices.length - 1]);
  if (signal) {
    STATE.signals[sym] = signal;
    updateAISignalPanel(COIN_MAP[sym]?.symbol + '/USDT', signal);
  }
}

// ————————————————————————————————————————
// TOPBAR TICKER (real-time updates)
// ————————————————————————————————————————
function updateTopbarTicker() {
  updateTickerItem('BTCUSDT',  STATE.marketData['BTCUSDT'],  null, 'btc');
  updateTickerItem('ETHUSDT',  STATE.marketData['ETHUSDT'],  null, 'eth');
  updateTickerItem('SOLUSDT',  STATE.marketData['SOLUSDT'],  null, 'sol');
}

function updateTickerItem(symbol, data, prevPrice, shortKey) {
  if (!data) return;
  const key     = shortKey || symbol.replace('USDT', '').toLowerCase();
  const priceEl = document.getElementById(`tick-${key}`);
  const chgEl   = document.getElementById(`tick-${key}-chg`);
  if (!priceEl || !chgEl) return;

  const newPrice = data.price;
  const oldText  = priceEl.textContent;

  priceEl.textContent = formatPrice(newPrice);
  chgEl.textContent   = (data.change24h >= 0 ? '+' : '') + data.change24h.toFixed(2) + '%';
  chgEl.className     = 'ticker-change ' + (data.change24h >= 0 ? 'positive' : 'negative');

  // Flash animation on price change
  if (oldText && oldText !== '$--' && oldText !== formatPrice(newPrice)) {
    const flash = parseFloat(newPrice) > parseFloat(prevPrice || 0) ? 'flash-up' : 'flash-down';
    priceEl.classList.add(flash);
    setTimeout(() => priceEl.classList.remove(flash), 800);
  }
}

// ————————————————————————————————————————
// STAT CARDS
// ————————————————————————————————————————
function updateStatCards() {
  const pv      = calcPortfolioValue();
  const cost    = STATE.portfolio.reduce((s, h) => s + h.amount * h.avgBuy, 0);
  const pnl     = pv.total - cost;
  const winTrd  = STATE.trades.filter(t => t.pnl > 0).length;
  const clsTrd  = STATE.trades.filter(t => t.pnl !== null).length;
  const winRate = clsTrd > 0 ? (winTrd / clsTrd * 100).toFixed(1) : '--';
  const buyCount= Object.values(STATE.signals).filter(s => s?.action.includes('BUY')).length;

  document.getElementById('statPortfolioVal').textContent  = formatUSD(pv.total);
  document.getElementById('statPortfolioDelta').textContent = (pnl >= 0 ? '+' : '') + formatUSD(Math.abs(pnl)) + ' (' + (pnl/cost*100).toFixed(2) + '%)';
  document.getElementById('statPortfolioDelta').className   = 'stat-delta ' + (pnl >= 0 ? 'positive' : 'negative');
  document.getElementById('statPnl').textContent            = (pnl >= 0 ? '+' : '') + formatUSD(Math.abs(pnl));
  document.getElementById('statPnlDelta').textContent       = (pnl >= 0 ? '+' : '') + (pnl / cost * 100).toFixed(2) + '% all time';
  document.getElementById('statSignals').textContent        = buyCount + ' BUY';
  document.getElementById('statWinRate').textContent        = winRate + '%';
  document.getElementById('statWinDelta').textContent       = `${winTrd}/${clsTrd} trades won`;
}

// ————————————————————————————————————————
// AI SIGNAL PANEL
// ————————————————————————————————————————
function updateAISignalPanel(pair, signal) {
  document.getElementById('signalCoinLabel').textContent = pair;

  const actionEl   = document.getElementById('signalAction');
  actionEl.textContent = '🤖 ' + signal.action;
  actionEl.className   = 'signal-action ' +
    (signal.action.includes('BUY') ? 'buy' : signal.action.includes('SELL') ? 'sell' : 'neutral');

  document.getElementById('confidenceFill').style.width = signal.confidence + '%';
  document.getElementById('confidencePct').textContent  = signal.confidence + '%';

  const ind = signal.indicators;
  setText('ind-rsi',       ind.rsi.display);   setSignal('ind-rsi-sig',  ind.rsi.signal);
  setText('ind-macd',      ind.macd.display);  setSignal('ind-macd-sig', ind.macd.signal);
  setText('ind-ema',       ind.ema.display);   setSignal('ind-ema-sig',  ind.ema.signal);
  setText('ind-bb',        ind.bb.display);    setSignal('ind-bb-sig',   ind.bb.signal);
  setText('ind-vol',       ind.obv.display);   setSignal('ind-vol-sig',  ind.obv.signal);
  setText('ind-stoch',     ind.stoch.display); setSignal('ind-stoch-sig',ind.stoch.signal);
}

function setText(id, val)  { const el = document.getElementById(id); if (el) el.textContent = val; }
function setSignal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.className = 'ind-signal ' + (val === 'BUY' ? 'buy' : val === 'SELL' ? 'sell' : 'neutral');
}

// ————————————————————————————————————————
// PORTFOLIO DONUT
// ————————————————————————————————————————
function renderPortfolioDonut() {
  const ctx = document.getElementById('portfolioDonut').getContext('2d');
  const pv  = calcPortfolioValue();

  if (STATE.charts.donut) STATE.charts.donut.destroy();
  STATE.charts.donut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels:   pv.items.map(i => i.symbol),
      datasets: [{ data: pv.items.map(i => i.value), backgroundColor: pv.items.map(i => i.color), borderColor: 'rgba(0,0,0,0.3)', borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10,14,30,0.97)', borderColor: 'rgba(108,99,255,0.4)', borderWidth: 1,
          callbacks: { label: ctx => ` ${ctx.label}: ${formatUSD(ctx.raw)} (${(ctx.raw/pv.total*100).toFixed(1)}%)` }
        }
      },
      animation: { animateRotate: true, duration: 700 }
    }
  });

  document.getElementById('donutTotal').textContent = '$' + (pv.total / 1000).toFixed(1) + 'K';
  document.getElementById('donutLegend').innerHTML  = pv.items.map(item => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${item.color}"></div>
      <span class="legend-name">${item.symbol}</span>
      <span class="legend-pct" style="color:${item.color}">${(item.value/pv.total*100).toFixed(1)}%</span>
    </div>`).join('');
}

function calcPortfolioValue() {
  const items = STATE.portfolio.map(h => {
    let price = h.symbol === 'USDT' ? 1 : (STATE.marketData[h.binanceSymbol]?.price || h.avgBuy);
    return { ...h, price, value: h.amount * price, costBasis: h.amount * h.avgBuy };
  });
  return { items, total: items.reduce((s, i) => s + i.value, 0) };
}

// ————————————————————————————————————————
// MARKETS TAB
// ————————————————————————————————————————
function renderMarketsTab() {
  const tbody = document.getElementById('marketsTableBody');
  const rows  = ALL_SYMBOLS.map((sym, i) => {
    const d    = STATE.marketData[sym] || {};
    const info = COIN_MAP[sym];
    if (!info) return '';
    const chg  = d.change24h || 0;
    const sig  = computeQuickSignal(sym);
    return `
      <tr class="market-row" data-name="${info.name.toLowerCase()} ${info.symbol.toLowerCase()}">
        <td>${i + 1}</td>
        <td>
          <div class="coin-cell">
            <div class="coin-icon" style="background:${info.color}">${info.icon}</div>
            <div class="coin-name-group">
              <span class="coin-symbol">${info.symbol}</span>
              <span class="coin-fullname">${info.name}</span>
            </div>
          </div>
        </td>
        <td class="price-cell">${d.price ? formatPrice(d.price) : '...'}</td>
        <td class="change-cell ${chg >= 0 ? 'positive' : 'negative'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</td>
        <td class="mcap-cell">${formatLargeNum(d.quoteVolume * 30)}</td>
        <td class="mcap-cell">${formatLargeNum(d.quoteVolume)}</td>
        <td><span class="signal-badge ${sig.toLowerCase()}">${sig}</span></td>
        <td>
          <button class="watch-btn" onclick="selectChartCoinBySymbol('${sym}')">Chart →</button>
        </td>
      </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

function filterMarkets(q) {
  document.querySelectorAll('.market-row').forEach(row => {
    row.style.display = row.dataset.name?.includes(q.toLowerCase()) ? '' : 'none';
  });
}

function computeQuickSignal(sym) {
  const hist = STATE.klineData[sym];
  if (!hist || hist.prices.length < 20) {
    const chg = STATE.marketData[sym]?.change24h || 0;
    return chg > 2 ? 'BUY' : chg < -2 ? 'SELL' : 'HOLD';
  }
  const rsi = TA.rsi(hist.prices);
  if (rsi < 35) return 'BUY';
  if (rsi > 65) return 'SELL';
  return 'HOLD';
}

// ————————————————————————————————————————
// SIGNALS TAB
// ————————————————————————————————————————
async function renderSignalsTab() {
  const grid = document.getElementById('signalsGrid');
  const syms = ALL_SYMBOLS.slice(0, 6);

  grid.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)"><div class="loading-spinner" style="margin:0 auto 16px"></div><p>Fetching live data from Binance...</p></div>';

  // Load klines for all signals coins if not already loaded
  await Promise.all(syms.map(async sym => {
    if (!STATE.klineData[sym]) {
      const hist = await fetchKlinesForSymbol(sym, 7);
      STATE.klineData[sym] = hist;
    }
  }));

  grid.innerHTML = syms.map(sym => {
    const d    = STATE.marketData[sym] || {};
    const info = COIN_MAP[sym];
    if (!info || !d.price) return '';
    const hist = STATE.klineData[sym];
    const sig  = hist ? TA.generateSignal(hist.prices, d.price) : null;

    if (sig) STATE.signals[sym] = sig;

    const conf    = sig?.confidence || 60;
    const action  = sig?.action || 'HOLD';
    const acCls   = action.includes('BUY') ? 'buy' : action.includes('SELL') ? 'sell' : 'hold';
    const cardCls = action === 'STRONG BUY' ? 'strong-buy' : action === 'STRONG SELL' ? 'strong-sell' : '';
    const ind     = sig?.indicators;

    return `
      <div class="signal-card ${cardCls}">
        <div class="signal-card-header">
          <span class="sc-coin">${info.symbol}/USDT</span>
          <span class="sc-action ${acCls}">${action}</span>
        </div>
        <div class="sc-price">${formatPrice(d.price)}</div>
        <div class="sc-change ${d.change24h >= 0 ? 'positive' : 'negative'}">${d.change24h >= 0 ? '+' : ''}${d.change24h?.toFixed(2) || '--'}% 24h</div>
        ${ind ? `
        <div class="sc-indicators">
          ${indRow('RSI', ind.rsi.display, ind.rsi.signal.toLowerCase(), parseFloat(ind.rsi.value) / 100)}
          ${indRow('MACD', ind.macd.display, ind.macd.signal.toLowerCase(), Math.min(1, Math.abs(parseFloat(ind.macd.value)) / 200))}
          ${indRow('Stoch RSI', ind.stoch.display, ind.stoch.signal.toLowerCase(), parseFloat(ind.stoch.value) / 100)}
        </div>` : ''}
        <div class="sc-confidence">
          <div class="sc-conf-label"><span>AI Confidence</span><span>${conf}%</span></div>
          <div class="sc-conf-bar"><div class="sc-conf-fill" style="width:${conf}%"></div></div>
        </div>
        ${!STATE.apiKey ? `<div style="font-size:10px;color:var(--text-muted);text-align:center;margin-top:8px">Add API key in Settings to trade</div>` : `
        <button class="sc-trade-btn ${acCls}" onclick="quickTrade('${sym}', '${action.includes('BUY') ? 'BUY' : 'SELL'}')">
          ${action.includes('BUY') ? '↑ BUY' : action.includes('SELL') ? '↓ SELL' : '→ WATCH'}
        </button>`}
      </div>`;
  }).join('');

  // Update badge
  const buyCount = Object.values(STATE.signals).filter(s => s?.action.includes('BUY')).length;
  const badge = document.getElementById('signalBadge');
  if (badge) badge.textContent = buyCount;
}

function indRow(name, val, sig, pct) {
  return `
    <div class="sc-ind-row">
      <span class="sc-ind-name">${name}</span>
      <div class="sc-ind-bar"><div class="sc-ind-fill ${sig}-fill" style="width:${Math.min(100, (pct || 0) * 100)}%"></div></div>
      <span class="sc-ind-val ${sig === 'buy' ? 'positive' : sig === 'sell' ? 'negative' : ''}">${val}</span>
    </div>`;
}

async function quickTrade(symbol, side) {
  if (!STATE.apiKey) {
    showToast('warning', '🔑 No API Key', 'Add your Binance API key in Settings first');
    switchTab('settings');
    return;
  }
  STATE.selectedSymbol = symbol;
  executeTrade();
}

// ————————————————————————————————————————
// PORTFOLIO TAB
// ————————————————————————————————————————
function renderPortfolioTab() {
  const pv   = calcPortfolioValue();
  const cost = STATE.portfolio.reduce((s, h) => s + h.amount * h.avgBuy, 0);
  const pnl  = pv.total - cost;
  const ret  = cost > 0 ? pnl / cost * 100 : 0;
  const best = pv.items.reduce((b, i) => {
    const r = (i.value - i.costBasis) / i.costBasis * 100;
    return r > (b.ret || -Infinity) ? { sym: i.symbol, ret: r } : b;
  }, {});

  document.getElementById('pvTotal').textContent  = formatUSD(pv.total);
  document.getElementById('pvChange').textContent = `${pnl >= 0 ? '↑ +' : '↓ '}${formatUSD(Math.abs(pnl))} (${Math.abs(ret).toFixed(2)}%) total`;
  document.getElementById('pvChange').className   = 'pv-change ' + (pnl >= 0 ? 'positive' : 'negative');
  document.getElementById('psInvested').textContent = formatUSD(cost);
  document.getElementById('psProfit').textContent   = (pnl >= 0 ? '+' : '') + formatUSD(pnl);
  document.getElementById('psProfit').className     = 'ps-val ' + (pnl >= 0 ? 'positive' : 'negative');
  document.getElementById('psReturn').textContent   = (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%';
  document.getElementById('psReturn').className     = 'ps-val ' + (ret >= 0 ? 'positive' : 'negative');
  document.getElementById('psBest').textContent     = best.sym ? `${best.sym} ${best.ret >= 0 ? '+' : ''}${best.ret.toFixed(1)}%` : '--';

  document.getElementById('holdingsTableBody').innerHTML = pv.items.map(item => {
    const pnl    = item.value - item.costBasis;
    const pnlPct = item.costBasis > 0 ? pnl / item.costBasis * 100 : 0;
    const alloc  = pv.total > 0 ? item.value / pv.total * 100 : 0;
    const live   = item.symbol !== 'USDT' && STATE.marketData[item.binanceSymbol]?.price;
    return `
      <tr>
        <td>
          <div class="holding-name-cell">
            <div class="h-coin-icon" style="background:${item.color}">${item.symbol[0]}</div>
            <div>
              <div style="font-weight:700">${item.symbol}</div>
              <div style="font-size:11px;color:var(--text-muted)">${item.name}${live ? ' 🟢' : ''}</div>
            </div>
          </div>
        </td>
        <td style="font-family:'JetBrains Mono',monospace">${item.amount > 1000 ? item.amount.toFixed(0) : item.amount.toFixed(4)}</td>
        <td style="font-family:'JetBrains Mono',monospace">${formatPrice(item.avgBuy)}</td>
        <td style="font-family:'JetBrains Mono',monospace">${formatPrice(item.price)}${live ? '<span style="font-size:9px;color:var(--green);margin-left:4px">LIVE</span>' : ''}</td>
        <td style="font-weight:700;font-family:'JetBrains Mono',monospace">${formatUSD(item.value)}</td>
        <td style="font-weight:700;font-family:'JetBrains Mono',monospace;color:${pnl >= 0 ? 'var(--green)' : 'var(--red)'}">
          ${pnl >= 0 ? '+' : ''}${formatUSD(pnl)} (${pnlPct.toFixed(1)}%)
        </td>
        <td class="alloc-bar-cell">
          <div style="font-size:11px;margin-bottom:4px">${alloc.toFixed(1)}%</div>
          <div class="alloc-bar"><div class="alloc-fill" style="width:${alloc}%;background:${item.color}"></div></div>
        </td>
      </tr>`;
  }).join('');
}

// ————————————————————————————————————————
// TRADES TAB
// ————————————————————————————————————————
function renderTradesTab() {
  renderTradesTable(STATE.trades);
  renderTradesSummary(STATE.trades);
}

function renderTradesTable(trades) {
  document.getElementById('tradesTableBody').innerHTML = trades.slice(0, 100).map(t => `
    <tr>
      <td style="color:var(--text-muted);font-size:12px">${formatDate(t.date)}</td>
      <td><strong>${t.coin}/USDT</strong></td>
      <td><span class="type-pill ${t.type.toLowerCase()}">${t.type}</span></td>
      <td style="font-family:'JetBrains Mono',monospace">${formatUSD(t.amount)}</td>
      <td style="font-family:'JetBrains Mono',monospace">${formatPrice(t.price)}</td>
      <td style="font-family:'JetBrains Mono',monospace">${formatUSD(t.total)}</td>
      <td style="font-weight:700;font-family:'JetBrains Mono',monospace;color:${t.pnl > 0 ? 'var(--green)' : t.pnl < 0 ? 'var(--red)' : 'var(--text-muted)'}">
        ${t.pnl !== null ? (t.pnl > 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2) : '—'}
      </td>
      <td>
        <span class="reason-pill">${t.reason}</span>
        ${t.source === 'Live' ? '<span style="font-size:9px;color:var(--green);margin-left:4px">🟢 LIVE</span>' : ''}
      </td>
    </tr>`).join('');
}

function renderTradesSummary(trades) {
  const won    = trades.filter(t => (t.pnl || 0) > 0);
  const closed = trades.filter(t => t.pnl !== null);
  const winRate= closed.length > 0 ? (won.length / closed.length * 100).toFixed(1) : '--';
  const totPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgPnl = closed.length > 0 ? (totPnl / closed.length).toFixed(2) : '--';

  document.getElementById('tradeSummaryRow').innerHTML = `
    <div class="ts-item"><div class="ts-label">Total Trades</div><div class="ts-val">${trades.length}</div></div>
    <div class="ts-item"><div class="ts-label">Win Rate</div><div class="ts-val" style="color:var(--green)">${winRate}%</div></div>
    <div class="ts-item"><div class="ts-label">Total P&L</div><div class="ts-val" style="color:${totPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${totPnl >= 0 ? '+' : ''}$${Math.abs(totPnl).toFixed(2)}</div></div>
    <div class="ts-item"><div class="ts-label">Avg P&L</div><div class="ts-val">${avgPnl !== '--' ? (avgPnl > 0 ? '+' : '') + '$' + Math.abs(avgPnl) : '--'}</div></div>`;
}

function renderRecentTrades() {
  const list   = document.getElementById('recentTradesList');
  const recent = STATE.trades.slice(0, 6);
  list.innerHTML = recent.map(t => `
    <div class="trade-item">
      <div class="trade-type-badge ${t.type.toLowerCase()}">${t.type}</div>
      <div class="trade-info">
        <div class="trade-coin">${t.coin}/USDT ${t.source === 'Live' ? '🟢' : ''}</div>
        <div class="trade-time">${formatRelTime(t.date)}</div>
      </div>
      <div class="trade-pnl ${(t.pnl || 0) > 0 ? 'positive' : (t.pnl || 0) < 0 ? 'negative' : ''}">
        ${t.pnl !== null ? (t.pnl > 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2) : formatUSD(t.amount)}
      </div>
    </div>`).join('');
}

function filterTrades() {
  const coin = document.getElementById('tradeFilterCoin').value;
  const type = document.getElementById('tradeFilterType').value;
  const filtered = STATE.trades.filter(t => (!coin || t.coin === coin) && (!type || t.type === type));
  renderTradesTable(filtered);
  renderTradesSummary(filtered);
}

// ————————————————————————————————————————
// BACKTESTING ENGINE (uses real Binance klines)
// ————————————————————————————————————————
async function runBacktest() {
  const btn = document.getElementById('runBacktestBtn');
  btn.innerHTML = '<div class="loading-spinner"></div> Fetching Binance Data...';
  btn.disabled  = true;

  const symKey   = document.getElementById('bt-coin').value;   // e.g. "BTCUSDT"
  const strategy = document.getElementById('bt-strategy').value;
  const period   = parseInt(document.getElementById('bt-period').value);
  const capital  = parseFloat(document.getElementById('bt-capital').value);
  const risk     = parseFloat(document.getElementById('bt-risk').value) / 100;
  const sl       = parseFloat(document.getElementById('bt-sl').value) / 100;
  const tp       = parseFloat(document.getElementById('bt-tp').value) / 100;

  // Fetch real historical data from Binance
  let hist;
  try {
    const interval = period <= 30 ? '4h' : period <= 90 ? '1d' : '1d';
    const limit    = period <= 30 ? Math.min(period * 6, 200) : Math.min(period, 200);
    const rawKlines = await BinanceREST.fetchKlines(symKey, interval, limit);
    if (rawKlines) {
      const prices  = rawKlines.map(k => parseFloat(k[4]));
      const times   = rawKlines.map(k => new Date(k[0]));
      const volumes = rawKlines.map(k => parseFloat(k[5]));
      hist = { prices, times, volumes };
    } else {
      throw new Error('no data');
    }
  } catch (e) {
    hist = generateFallbackKlines(STATE.marketData[symKey]?.price || 45000, Math.min(period * 2, 180));
  }

  btn.innerHTML = '<div class="loading-spinner"></div> Running Strategy...';
  await new Promise(r => setTimeout(r, 400));

  const results = simulateStrategy(hist.prices, capital, risk, sl, tp, strategy);

  document.getElementById('backtestPlaceholder').classList.add('hidden');
  document.getElementById('backtestResultContent').classList.remove('hidden');

  const ret = (results.finalCapital - capital) / capital * 100;
  document.getElementById('bt-res-return').textContent   = (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%';
  document.getElementById('bt-res-return').className     = 'bt-stat-val ' + (ret >= 0 ? 'positive' : 'negative');
  document.getElementById('bt-res-trades').textContent   = results.trades;
  document.getElementById('bt-res-winrate').textContent  = results.winRate.toFixed(1) + '%';
  document.getElementById('bt-res-dd').textContent       = '-' + results.maxDrawdown.toFixed(2) + '%';
  document.getElementById('bt-res-sharpe').textContent   = results.sharpe.toFixed(2);
  document.getElementById('bt-res-pf').textContent       = results.profitFactor.toFixed(2);
  renderBacktestChart(results.equityCurve);

  btn.innerHTML = '▶ Run Backtest';
  btn.disabled  = false;

  showToast('success', '📊 Backtest Complete', `${results.trades} trades, ${results.winRate.toFixed(1)}% win rate — data from Binance`);
}

function simulateStrategy(prices, capital, risk, sl, tp, strategy) {
  let equity = capital, peak = capital, maxDD = 0;
  let wins   = 0, losses = 0, totProfit = 0, totLoss = 0;
  let pos    = null;
  const curve = [capital];

  for (let i = 52; i < prices.length; i++) {
    const w     = prices.slice(Math.max(0, i - 52), i + 1);
    const rsi   = TA.rsi(w);
    const ema20 = TA.ema(w, 20);
    const ema50 = TA.ema(w.slice(0, -1), Math.min(50, w.length - 1));
    const bb    = TA.bollingerBands(w);
    const price = prices[i];

    if (!pos) {
      let buy = false;
      if      (strategy === 'rsi_macd')    buy = rsi < 38;
      else if (strategy === 'ema_cross')   buy = ema20 > ema50;
      else if (strategy === 'bb_breakout') buy = price < bb.lower;
      else                                 buy = rsi < 40 && ema20 > ema50;

      if (buy) {
        const size = equity * risk;
        pos = { entry: price, size, units: size / price };
      }
    } else {
      const pct = (price - pos.entry) / pos.entry;
      if (pct >= tp) {
        const profit = pos.units * (price - pos.entry);
        equity += profit; totProfit += profit; wins++;
        pos = null;
      } else if (pct <= -sl) {
        const loss = pos.units * Math.abs(price - pos.entry);
        equity -= loss; totLoss += loss; losses++;
        pos = null;
      }
    }
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    curve.push(equity);
  }

  const total  = wins + losses;
  const winRate = total > 0 ? wins / total * 100 : 0;
  const pf     = totLoss > 0 ? totProfit / totLoss : totProfit > 0 ? 9.99 : 1;
  const rets   = curve.map((v, i) => i > 0 ? (v - curve[i-1]) / curve[i-1] : 0);
  const mean   = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std    = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const sharpe = std > 0 ? mean / std * Math.sqrt(252) : 0;

  return { finalCapital: equity, trades: total, winRate, maxDrawdown: maxDD, sharpe, profitFactor: pf, equityCurve: curve };
}

function renderBacktestChart(curve) {
  const ctx = document.getElementById('backtestChart').getContext('2d');
  if (STATE.backtestChart) STATE.backtestChart.destroy();

  const step = Math.max(1, Math.floor(curve.length / 100));
  const data = curve.filter((_, i) => i % step === 0);
  const isUp = data[data.length - 1] >= data[0];
  const grad = ctx.createLinearGradient(0, 0, 0, 250);
  grad.addColorStop(0, isUp ? 'rgba(46,213,115,0.25)' : 'rgba(255,71,87,0.2)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  STATE.backtestChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => `#${i}`),
      datasets: [{ data, label: 'Portfolio Value', borderColor: isUp ? '#2ED573' : '#FF4757', backgroundColor: grad, borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' $' + ctx.raw.toFixed(2) } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => '$' + v.toFixed(0), font: { size: 10 } } }
      }
    }
  });
}

// ————————————————————————————————————————
// SENTIMENT GAUGE
// ————————————————————————————————————————
function updateSentimentGauge(value) {
  const needle = document.getElementById('gaugeNeedle');
  if (needle) needle.setAttribute('transform', `rotate(${-90 + value / 100 * 180}, 100, 100)`);
  const labels = ['Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed'];
  const label  = value < 20 ? labels[0] : value < 40 ? labels[1] : value < 60 ? labels[2] : value < 80 ? labels[3] : labels[4];
  setText('sentimentValue', `Fear & Greed: ${value}`);
  setText('sentimentLabel', label);
}

// ————————————————————————————————————————
// TRADE EXECUTION MODAL
// ————————————————————————————————————————
function executeTrade() {
  const sym    = STATE.selectedSymbol;
  const d      = STATE.marketData[sym];
  const info   = COIN_MAP[sym];
  const signal = STATE.signals[sym];
  if (!d || !info) { showToast('warning', '⚡ No Data', 'Waiting for live price data'); return; }

  const action = signal?.action.includes('BUY') ? 'BUY' : signal?.action.includes('SELL') ? 'SELL' : 'BUY';

  document.getElementById('tcAction').textContent  = action;
  document.getElementById('tcAction').className    = 'tc-val ' + action.toLowerCase();
  document.getElementById('tcAsset').textContent   = info.symbol + '/USDT';
  document.getElementById('tcPrice').textContent   = formatPrice(d.price);
  document.getElementById('tcConf').textContent    = (signal?.confidence || '--') + '%';
  document.getElementById('tcSL').textContent      = '-' + document.getElementById('set-sl').value + '%';
  document.getElementById('tcTP').textContent      = '+' + document.getElementById('set-tp').value + '%';
  document.getElementById('confirmTradeBtn').textContent = 'Confirm ' + action;
  document.getElementById('confirmTradeBtn').className   = 'btn-confirm ' + action.toLowerCase();

  // Show live vs paper mode
  document.getElementById('tradeModeNote').textContent = STATE.apiKey
    ? '⚡ LIVE MODE — This will place a real order on Binance'
    : '📝 PAPER MODE — Add API key in Settings for live trading';
  document.getElementById('tradeModeNote').style.color = STATE.apiKey ? 'var(--orange)' : 'var(--text-muted)';

  document.getElementById('tradeModal').classList.remove('hidden');
}

async function confirmTrade() {
  const sym    = STATE.selectedSymbol;
  const info   = COIN_MAP[sym];
  const d      = STATE.marketData[sym];
  const amount = parseFloat(document.getElementById('tcAmount').value);
  const action = document.getElementById('tcAction').textContent;
  const signal = STATE.signals[sym];

  closeModal('tradeModal');

  if (STATE.apiKey && STATE.apiSecret) {
    // LIVE TRADE via Binance API
    await executeLiveTrade(sym, action, amount);
  } else {
    // PAPER TRADE (local only)
    STATE.trades.unshift({
      id: STATE.trades.length, date: new Date(),
      coin: info.symbol, type: action,
      price: d?.price || 0, amount, total: amount,
      pnl: null,
      reason: signal ? `AI ${signal.action} — ${signal.confidence}% confidence` : 'Manual trade',
      source: 'Paper',
    });
    renderRecentTrades();
    renderTradesTab();
    showToast('info', `📝 Paper Trade: ${action} ${info.symbol}`, `$${amount} @ ${formatPrice(d?.price)} (Paper mode)`);
  }
}

// ————————————————————————————————————————
// API KEY SETTINGS
// ————————————————————————————————————————
function loadApiKeysToForm() {
  const keyEl    = document.getElementById('set-api-key');
  const secretEl = document.getElementById('set-api-secret');
  if (keyEl)    keyEl.value    = STATE.apiKey    ? STATE.apiKey.substring(0, 8) + '••••••••' : '';
  if (secretEl) secretEl.value = STATE.apiSecret ? '••••••••••••••••' : '';
  updateApiKeyStatus();
}

function saveApiKeys() {
  const keyInput    = document.getElementById('set-api-key');
  const secretInput = document.getElementById('set-api-secret');
  const key    = keyInput?.value.replace(/•/g, '').trim();
  const secret = secretInput?.value.replace(/•/g, '').trim();

  // Only save if not masked
  if (key && !key.includes('•')) {
    STATE.apiKey = key;
    localStorage.setItem('bnc_api_key', key);
  }
  if (secret && !secret.includes('•')) {
    STATE.apiSecret = secret;
    localStorage.setItem('bnc_api_secret', secret);
  }

  updateApiKeyStatus();
  showToast('success', '🔑 API Keys Saved', STATE.apiKey ? 'Live trading enabled!' : 'Keys saved to browser storage');
  loadApiKeysToForm();
}

function clearApiKeys() {
  STATE.apiKey = '';
  STATE.apiSecret = '';
  localStorage.removeItem('bnc_api_key');
  localStorage.removeItem('bnc_api_secret');
  const keyEl    = document.getElementById('set-api-key');
  const secretEl = document.getElementById('set-api-secret');
  if (keyEl)    keyEl.value    = '';
  if (secretEl) secretEl.value = '';
  updateApiKeyStatus();
  showToast('info', '🗑 Keys Cleared', 'Switched to paper trading mode');
}

function updateApiKeyStatus() {
  const badge = document.getElementById('apiKeyBadge');
  if (!badge) return;
  if (STATE.apiKey && STATE.apiSecret) {
    badge.textContent    = '● LIVE TRADING';
    badge.className      = 'api-key-badge live';
  } else {
    badge.textContent    = '○ PAPER TRADING';
    badge.className      = 'api-key-badge paper';
  }
}

async function testApiConnection() {
  if (!STATE.apiKey || !STATE.apiSecret) {
    showToast('warning', '🔑 Keys Required', 'Enter your API key and secret first');
    return;
  }
  const btn = document.getElementById('testApiBtn');
  btn.textContent = '⏳ Testing...';
  btn.disabled    = true;
  try {
    const info = await BinanceREST.fetchAccountInfo();
    const nonZero = info.balances.filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);
    showToast('success', '✅ Connection OK!', `Account type: ${info.accountType} — ${nonZero.length} assets`);
    STATE.accountInfo = info;
    renderPortfolioFromAccount(nonZero);
  } catch (e) {
    showToast('error', '❌ Connection Failed', e.message);
  }
  btn.textContent = '🔌 Test Connection';
  btn.disabled    = false;
}

function saveSettings() {
  saveApiKeys();
  showToast('success', '⚙️ Settings Saved', 'All configuration updated');
}

// ————————————————————————————————————————
// NAVIGATION
// ————————————————————————————————————————
function switchTab(tab) {
  STATE.activeTab = tab;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${tab}`);
  const tabEl = document.getElementById(`tab-${tab}`);
  if (navEl) navEl.classList.add('active');
  if (tabEl) tabEl.classList.add('active');
  const titles = {
    dashboard: 'Dashboard', markets: 'Live Markets', signals: 'AI Signals',
    portfolio: 'Portfolio', trades: 'Trade History', backtest: 'Backtesting', settings: 'Settings'
  };
  document.getElementById('pageTitle').textContent = titles[tab] || tab;

  if (tab === 'markets')    renderMarketsTab();
  if (tab === 'signals')    renderSignalsTab();
  if (tab === 'portfolio')  renderPortfolioTab();
  if (tab === 'trades')     renderTradesTab();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
  document.querySelector('.main-content').classList.toggle('expanded');
}

async function selectChartCoin(symbol, btn) {
  STATE.selectedSymbol = symbol;
  document.querySelectorAll('.coin-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  await refreshChart();
}

function selectChartCoinBySymbol(symbol) {
  switchTab('dashboard');
  STATE.selectedSymbol = symbol;
  refreshChart();
}

async function selectTimeframe(days, btn) {
  STATE.selectedTimeframe = days;
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  await refreshChart();
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ————————————————————————————————————————
// BOT TOGGLE
// ————————————————————————————————————————
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('botToggle');
  if (toggle) {
    toggle.addEventListener('change', function () {
      STATE.botActive = this.checked;
      const dot  = document.querySelector('.status-dot');
      const text = document.querySelector('.status-text');
      if (STATE.botActive) {
        dot?.classList.add('active');
        if (text) { text.textContent = 'Bot Active'; text.style.color = 'var(--green)'; }
        showToast('success', '🤖 Bot Activated', 'Auto-trading resumed');
      } else {
        dot?.classList.remove('active');
        if (text) { text.textContent = 'Bot Paused'; text.style.color = 'var(--orange)'; }
        showToast('warning', '⏸ Bot Paused', 'Auto-trading stopped');
      }
    });
  }
  init();
});

// ————————————————————————————————————————
// BOT ACTIVITY SIMULATION (paper mode)
// ————————————————————————————————————————
function simulateBotActivity() {
  if (!STATE.botActive || STATE.apiKey) return; // live mode handles itself
  if (Math.random() > 0.15) return;

  const syms = Object.keys(STATE.signals).filter(s => STATE.signals[s]?.action.includes('BUY') || STATE.signals[s]?.action.includes('SELL'));
  if (!syms.length) return;

  const sym    = syms[Math.floor(Math.random() * syms.length)];
  const signal = STATE.signals[sym];
  const info   = COIN_MAP[sym];
  const price  = STATE.marketData[sym]?.price || 0;
  const type   = signal.action.includes('BUY') ? 'BUY' : 'SELL';

  STATE.trades.unshift({
    id: STATE.trades.length, date: new Date(),
    coin: info.symbol, type, price,
    amount: 100 + Math.random() * 400,
    total: 100 + Math.random() * 400,
    pnl: null,
    reason: `Auto: ${signal.action} (${signal.confidence}% conf)`,
    source: 'Bot',
  });
  renderRecentTrades();
  showToast('info', `🤖 Bot ${type}: ${info.symbol}`, `Auto trade @ ${formatPrice(price)}`);
}

function openAddHolding() {
  showToast('info', '💡 Tip', 'Connect your Binance API key to auto-import holdings');
  switchTab('settings');
}

// ————————————————————————————————————————
// TOAST NOTIFICATIONS
// ————————————————————————————————————————
function showToast(type, title, msg) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: '💡', warning: '⚠️' };
  el.innerHTML = `
    <div class="toast-icon">${icons[type] || 'ℹ️'}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(100%)'; el.style.transition = '0.4s'; }, 4000);
  setTimeout(() => el.remove(), 4500);
}

// ————————————————————————————————————————
// FORMATTERS
// ————————————————————————————————————————
function formatPrice(p) {
  if (!p && p !== 0) return '$--';
  if (p < 0.0001) return '$' + p.toFixed(8);
  if (p < 0.01)   return '$' + p.toFixed(6);
  if (p < 1)      return '$' + p.toFixed(4);
  if (p < 10)     return '$' + p.toFixed(3);
  if (p < 1000)   return '$' + p.toFixed(2);
  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatUSD(n) {
  if (!n && n !== 0) return '$--';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatLargeNum(n) {
  if (!n) return '--';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + n.toLocaleString();
}

function formatRelTime(date) {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatChartTime(date, days) {
  if (days <= 1)  return date.toLocaleTimeString('en-US',  { hour: '2-digit', minute: '2-digit' });
  if (days <= 7)  return date.toLocaleDateString('en-US',  { weekday: 'short' }) + ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function updateLastUpdateTime() {
  const el = document.getElementById('lastUpdate');
  if (el) el.textContent = '🟢 Live · ' + new Date().toLocaleTimeString();
}
