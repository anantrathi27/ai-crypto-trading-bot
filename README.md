# 🤖 CryptoMind AI — Intelligent Crypto Trading Bot

A real-time AI-powered cryptocurrency trading bot dashboard built with **Vanilla HTML, CSS & JavaScript**, connected to the **Binance API** via WebSocket and REST.

![Dashboard Preview](https://img.shields.io/badge/Status-Live-brightgreen) ![Binance API](https://img.shields.io/badge/API-Binance-yellow) ![License](https://img.shields.io/badge/License-MIT-blue)

---

## ✨ Features

- **🔴 Live Prices** — Real-time streaming via Binance WebSocket (`@miniTicker`) for 10 coins
- **📊 Interactive Charts** — Price charts using real Binance klines (1h/4h/1d candles)
- **🤖 AI Signal Engine** — Multi-indicator analysis: RSI, MACD, EMA Cross, Bollinger Bands, Stoch RSI
- **💼 Portfolio Tracker** — Holdings with live P&L, allocation chart
- **📋 Trade History** — Full trade log with AI reasoning
- **⏱ Backtesting** — Simulate strategies on real Binance historical data
- **⚡ Live Trading** — Place real Binance orders with your API key (optional)
- **📝 Paper Trading** — Works fully without an API key

---

## 🚀 Getting Started

### No installation needed — just open in your browser!

```bash
git clone https://github.com/YOUR_USERNAME/ai-crypto-trading-bot.git
cd ai-crypto-trading-bot
open index.html       # macOS
# or double-click index.html on Windows/Linux
```

---

## 🔑 Connecting Your Binance API (Optional)

> **Without API keys:** Live prices, signals, charts, backtesting, and paper trading all work for free.

> **With API keys:** Real order placement, live balance sync, trade history from Binance.

1. Log in to [Binance](https://www.binance.com) → Account → API Management
2. Create a new API key with **Spot Trading** permission only ⚠️ Never enable withdrawal
3. In the app, go to **Settings** → paste your API Key + Secret → **Save & Enable**
4. Click **Test Connection** to verify

> 🔒 Keys are stored only in your browser's `localStorage` and sent directly to Binance — never to any third party.

---

## 🧠 AI Signal Engine

The bot computes signals from real kline close prices using:

| Indicator | Signal Logic |
|-----------|-------------|
| RSI (14) | < 35 = BUY, > 65 = SELL |
| MACD | Positive histogram = BUY |
| EMA 20/50 | Golden cross = BUY, Death cross = SELL |
| Bollinger Bands | Price < lower = BUY, Price > upper = SELL |
| Stochastic RSI | < 25 = BUY, > 75 = SELL |
| Volume (OBV) | Rising momentum = BUY |

Each indicator is weighted and combined into a **confidence score (%)** and final action: `STRONG BUY / BUY / HOLD / SELL / STRONG SELL`

---

## 📡 Binance API Endpoints Used

| Feature | Endpoint |
|---------|----------|
| 24h Ticker Stats | `GET /api/v3/ticker/24hr` |
| Kline / Candlestick | `GET /api/v3/klines` |
| Real-time stream | `wss://stream.binance.com:9443/stream` |
| Account Info | `GET /api/v3/account` *(signed)* |
| Place Order | `POST /api/v3/order` *(signed)* |

---

## 🛠 Tech Stack

- **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES2022)
- **Charts:** Chart.js v4
- **API:** Binance REST + WebSocket
- **Crypto Signing:** Web Crypto API (`SubtleCrypto` HMAC-SHA256)
- **Storage:** `localStorage` for API keys and settings

---

## ⚠️ Disclaimer

This project is for **educational purposes only**. Cryptocurrency trading involves significant financial risk. The AI signals are not financial advice. Always do your own research before trading.

---

## 📄 License

MIT © 2024
