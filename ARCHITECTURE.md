# TrustTrade JavaScript - Architecture Overview

## 📐 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     TrustTrade Bot                          │
│                      (index.js)                             │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Telegram   │   │   Binance    │   │     Web      │
│    Client    │   │   Trader     │   │  Dashboard   │
└──────────────┘   └──────────────┘   └──────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│    Signal    │   │   Trading    │   │   Express    │
│    Parser    │   │   Strategy   │   │    Server    │
└──────────────┘   └──────────────┘   └──────────────┘
```

## 🔄 Data Flow

```
1. Telegram Signal Received
   │
   ▼
2. Signal Parser Extracts Data
   │
   ▼
3. Trading Strategy Validates
   │
   ├─ Check Symbol
   ├─ Check Position Limits
   ├─ Check Balance
   ├─ Calculate Risk:Reward
   └─ Calculate Position Size
   │
   ▼
4. Binance Trader Executes
   │
   ├─ Set Leverage
   ├─ Place Entry Order
   ├─ Monitor Fill
   └─ Place TP/SL Orders
   │
   ▼
5. Web Dashboard Updates
```

## 📦 Module Breakdown

### 1. index.js (Main Application)
**Purpose**: Orchestrates all components
- Initializes all modules
- Handles signal routing
- Manages lifecycle
- Graceful shutdown

### 2. telegram/telegramClient.js
**Purpose**: Telegram communication
- Connects to Telegram
- Listens to channel
- Receives messages
- Deduplication
- Session management

### 3. parsers/signalParser.js
**Purpose**: Message parsing
- Normalizes text
- Extracts trading data
- Supports multiple formats
- Validates signal structure

### 4. binance/binanceTrader.js
**Purpose**: Binance API interaction
- Account management
- Order placement
- Position tracking
- Symbol validation
- Rate limiting

### 5. strategy/tradingStrategy.js
**Purpose**: Trading logic
- Signal validation
- Risk management
- TP/SL calculation
- Order monitoring
- Position management

### 6. web/dashboard.js
**Purpose**: Monitoring interface
- Real-time data display
- Position tracking
- Order status
- Account balance
- Auto-refresh

### 7. utils/logger.js
**Purpose**: Logging system
- Structured logging
- File rotation
- Console output
- Error tracking

## 🔐 Security Layers

```
┌─────────────────────────────────────┐
│     Environment Variables (.env)    │
│  - API Keys (never in code)         │
│  - Credentials (encrypted storage)  │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│      API Rate Limiting              │
│  - Throttle requests                │
│  - Prevent bans                     │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│      Risk Management                │
│  - Position limits                  │
│  - Balance checks                   │
│  - R:R validation                   │
└─────────────────────────────────────┘
```

## 🎯 Trading Flow

### Entry Signal Flow
```
Signal Received
    │
    ├─ Parse Message
    │   └─ Extract: Symbol, Direction, Entry, Leverage
    │
    ├─ Validate Symbol
    │   └─ Check if tradable on Binance
    │
    ├─ Check Limits
    │   ├─ Max positions
    │   ├─ Existing position
    │   └─ Sufficient balance
    │
    ├─ Calculate
    │   ├─ Position size
    │   ├─ TP prices (TP1, TP2)
    │   ├─ SL price
    │   └─ Risk:Reward ratio
    │
    ├─ Validate R:R
    │   └─ Must meet minimum (default 1.5)
    │
    ├─ Place Entry Order
    │   └─ Limit order at entry price
    │
    └─ Monitor Fill
        └─ Check every 10 seconds
            │
            ├─ If Filled → Place TP/SL
            └─ If Timeout → Cancel order
```

### TP/SL Placement Flow
```
Entry Order Filled
    │
    ├─ Calculate Quantities
    │   ├─ TP1: 50% of position
    │   └─ TP2: 50% of position
    │
    ├─ Place TP1 Order
    │   └─ Take Profit Market @ TP1 price
    │
    ├─ Place TP2 Order
    │   └─ Take Profit Market @ TP2 price
    │
    └─ Place SL Order
        └─ Stop Market @ SL price
```

## 📊 State Management

```javascript
// Active Signals Map
{
  "BTCUSDT": {
    signal: {...},
    entryOrderId: 12345,
    quantity: 0.001,
    entryPrice: 45000,
    tp1Price: 45225,
    tp2Price: 45900,
    slPrice: 41850,
    tp1OrderId: 12346,
    tp2OrderId: 12347,
    slOrderId: 12348
  }
}
```

## 🌐 Web Dashboard API

```
GET /                    → Dashboard HTML
GET /api/positions       → Current positions
GET /api/orders          → Open orders
GET /api/account         → Account balance
```

## 🔧 Configuration Hierarchy

```
1. Environment Variables (.env)
   │
   ├─ Required
   │   ├─ Telegram credentials
   │   └─ Binance API keys
   │
   ├─ Trading Parameters
   │   ├─ Leverage
   │   ├─ Position limits
   │   └─ Risk settings
   │
   └─ Feature Toggles
       ├─ Filters (enable/disable)
       └─ Alert settings
```

## 🚀 Deployment Options

### Option 1: Local Machine
```bash
npm start
# Runs on your computer
# Dashboard: http://localhost:5000
```

### Option 2: VPS/Cloud Server
```bash
# Install Node.js on server
# Clone repository
# Configure .env
# Run with PM2 for auto-restart
pm2 start index.js --name trusttrade
```

### Option 3: Docker (Future)
```bash
# Build image
docker build -t trusttrade .
# Run container
docker run -d trusttrade
```

## 📈 Monitoring Stack

```
Bot Logs (Winston)
    │
    ├─ Console Output (Real-time)
    │   └─ Colored, formatted
    │
    └─ File Logs (Persistent)
        └─ Daily rotation, 5MB max
            │
            ▼
Web Dashboard (Express)
    │
    ├─ Positions (Real-time)
    ├─ Orders (Live updates)
    └─ Balance (Current)
        │
        ▼
Optional: Telegram Alerts
    └─ Critical events
```

## 🔄 Error Handling

```
Try-Catch Blocks
    │
    ├─ API Errors
    │   ├─ Rate limits → Retry with backoff
    │   ├─ Invalid orders → Log and skip
    │   └─ Connection errors → Reconnect
    │
    ├─ Parsing Errors
    │   └─ Invalid signals → Log and ignore
    │
    └─ System Errors
        └─ Uncaught exceptions → Log and exit
```

## 🎓 Extension Points

Want to add features? Here's where:

1. **New Filters** → `strategy/tradingStrategy.js`
2. **Technical Indicators** → Create `indicators/` folder
3. **Alert System** → Create `alerts/` folder
4. **Journal** → Create `journal/` folder
5. **Backtesting** → Create `backtest/` folder

---

**This architecture is modular, scalable, and production-ready!**
