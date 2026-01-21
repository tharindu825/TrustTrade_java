# TrustTrade JavaScript Bot

A professional cryptocurrency trading bot that reads signals from Telegram channels and automatically executes trades on Binance Futures.

## 🚀 Features

### Core Functionality
- ✅ **Telegram Signal Reading** - Automatically reads and parses trading signals from Telegram channels
- ✅ **Binance Futures Trading** - Executes trades on Binance Futures with full automation
- ✅ **Multiple Signal Formats** - Supports both new and legacy signal formats
- ✅ **Limit & Market Orders** - Handles both limit entry orders and market orders
- ✅ **Automated TP/SL** - Automatically places Take Profit and Stop Loss orders
- ✅ **Position Management** - Tracks and manages multiple positions simultaneously

### Risk Management
- 📊 **Position Sizing** - Automatic position size calculation based on account balance
- 🎯 **Risk:Reward Filtering** - Validates trades meet minimum R:R ratio
- 🛡️ **Leverage Control** - Configurable leverage with safety limits
- 💰 **Balance Protection** - Minimum balance checks before trading
- ⏱️ **Trade Cooldown** - Prevents overtrading with configurable cooldowns
- 🔒 **API Rate Limiting** - Built-in rate limiting to prevent API bans

### Monitoring & Alerts
- 🌐 **Web Dashboard** - Beautiful real-time dashboard for monitoring trades
- 📝 **Structured Logging** - Comprehensive logging with rotation
- 🔔 **Telegram Alerts** - Optional Telegram notifications for trade events
- 📊 **Position Tracking** - Real-time position and PNL monitoring

## 📋 Prerequisites

- **Node.js** v18 or higher
- **Binance Account** with Futures enabled
- **Telegram Account** with API credentials
- **API Keys** from Binance (Trading + Monitoring)

## 🔧 Installation

### 1. Clone or Download

```bash
cd "f:/Onedrive/Tharindu/Softwares/Python Projects/Telegram Signal_Fetch/Hello_Traders/Java"
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# Telegram Configuration
API_ID=your_telegram_api_id
API_HASH=your_telegram_api_hash
PHONE_NUMBER=+1234567890
CHANNEL_ID=@your_channel

# Binance API Keys
TRADING_API_KEY=your_binance_api_key
TRADING_SECRET_KEY=your_binance_secret_key
MONITORING_API_KEY=your_monitoring_api_key
MONITORING_SECRET_KEY=your_monitoring_secret_key

# Trading Mode
TRADING_MODE=testnet  # or 'live'
```

### 4. Get Telegram API Credentials

1. Go to https://my.telegram.org/apps
2. Log in with your phone number
3. Create a new application
4. Copy `API_ID` and `API_HASH`

### 5. Get Binance API Keys

1. Log in to Binance
2. Go to API Management
3. Create new API keys with Futures permissions
4. Enable IP restrictions for security
5. Create separate keys for Trading and Monitoring

## 🎮 Usage

### Start the Bot

```bash
npm start
```

### Development Mode (with auto-restart)

```bash
npm run dev
```

### First Run

On first run, you'll be prompted to:
1. Enter the Telegram verification code sent to your phone
2. Enter 2FA password (if enabled)

The bot will save your session for future runs.

## 📊 Web Dashboard

Access the monitoring dashboard at:

```
http://localhost:5000
```

The dashboard shows:
- Current account balance
- Open positions with PNL
- Active orders
- Auto-refreshes every 10 seconds

## 🔄 How It Works

### Signal Flow

```
Telegram Channel → Signal Parser → Validation → Binance Order → Monitoring
```

### 1. Signal Detection

The bot listens to your configured Telegram channel and parses messages like:

```
🔥#BTC/USDT (Long📈, x20)🔥
Entry - 45000
```

### 2. Signal Parsing

Extracts:
- **Symbol**: BTCUSDT
- **Direction**: LONG or SHORT
- **Entry Price**: 45000
- **Leverage**: 20x

### 3. Validation

Checks:
- ✅ Valid symbol on Binance
- ✅ No existing position
- ✅ Within position limits
- ✅ Sufficient balance
- ✅ Risk:Reward ratio meets minimum

### 4. Order Execution

Places:
1. **Limit Entry Order** at specified price
2. Monitors for fill
3. Once filled, places:
   - **TP1 Order** (50% position at TP1 price)
   - **TP2 Order** (50% position at TP2 price)
   - **SL Order** (full position at SL price)

### 5. Position Management

- Monitors order fills
- Cancels orders on timeout
- Handles opposite direction signals
- Tracks PNL in real-time

## ⚙️ Configuration

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_OPEN_POSITIONS` | 1 | Maximum concurrent positions |
| `DEFAULT_LEVERAGE` | 20 | Default leverage multiplier |
| `SL_PERCENTAGE` | 0.07 | Stop loss percentage (7%) |
| `TP1_ROI` | 0.5 | First take profit ROI (50%) |
| `TP2_ROI` | 2.0 | Second take profit ROI (200%) |
| `MIN_RISK_REWARD` | 1.5 | Minimum risk:reward ratio |
| `TARGET_MARGIN_PER_TRADE` | 1.0 | USDT margin per trade |

### Risk Filters

Enable/disable filters in `.env`:

```env
ENABLE_RISK_REWARD_FILTER=true
ENABLE_VOLATILITY_FILTER=true
ENABLE_SPREAD_FILTER=true
```

## 📁 Project Structure

```
Java/
├── index.js                 # Main entry point
├── package.json             # Dependencies
├── .env                     # Configuration (create from .env.example)
├── src/
│   ├── binance/
│   │   └── binanceTrader.js    # Binance API client
│   ├── parsers/
│   │   └── signalParser.js     # Telegram message parser
│   ├── strategy/
│   │   └── tradingStrategy.js  # Trading logic & execution
│   ├── telegram/
│   │   └── telegramClient.js   # Telegram client
│   ├── utils/
│   │   └── logger.js           # Logging utility
│   └── web/
│       └── dashboard.js        # Web monitoring dashboard
└── logs/                    # Log files (auto-created)
```

## 🔐 Security Best Practices

1. **Never commit `.env`** - It contains sensitive API keys
2. **Use IP restrictions** on Binance API keys
3. **Separate API keys** for trading and monitoring
4. **Start with testnet** before going live
5. **Use isolated margin** to limit risk per position
6. **Set conservative leverage** (10-20x max recommended)

## 🐛 Troubleshooting

### Bot won't connect to Telegram

- Verify `API_ID` and `API_HASH` are correct
- Check phone number format includes country code (+1234567890)
- Delete session file and restart for fresh login

### Orders not placing on Binance

- Verify API keys have Futures permissions
- Check IP restrictions on API keys
- Ensure sufficient balance in Futures wallet
- Check Binance API status

### "Invalid symbol" errors

- Ensure symbol exists on Binance Futures
- Check symbol format (must end with USDT)
- Verify symbol is actively trading

### Rate limit errors

- Increase `API_REQUEST_DELAY` in `.env`
- Reduce `MAX_REQUESTS_PER_MINUTE`
- Check for multiple bot instances running

## 📝 Logging

Logs are stored in `logs/` directory with automatic rotation:

- **Console**: Real-time colored output
- **File**: Daily rotating files (5MB max, 5 days retention)
- **Levels**: DEBUG, INFO, WARN, ERROR

View logs:

```bash
tail -f logs/app-2024-01-19.log
```

## 🔄 Comparison with Python Version

| Feature | Python | JavaScript | Status |
|---------|--------|------------|--------|
| Telegram Client | ✅ Telethon | ✅ telegram | ✅ Equivalent |
| Binance API | ✅ python-binance | ✅ binance-api-node | ✅ Equivalent |
| Signal Parsing | ✅ | ✅ | ✅ Same logic |
| Order Execution | ✅ | ✅ | ✅ Same flow |
| TP/SL Management | ✅ | ✅ | ✅ Same strategy |
| Web Dashboard | ✅ Flask | ✅ Express | ✅ Equivalent |
| Risk Filters | ✅ | ⚠️ Partial | 🚧 Core filters implemented |
| Technical Indicators | ✅ | ❌ | 🚧 Can be added |
| Journal/Excel | ✅ | ❌ | 🚧 Can be added |
| License Validation | ✅ | ❌ | 🚧 Can be added |

## 🚧 Future Enhancements

- [ ] Technical indicator filters (RSI, MACD, EMA)
- [ ] Excel trading journal
- [ ] Advanced position sizing (ATR-based)
- [ ] Trailing stop-loss
- [ ] Symbol blacklisting
- [ ] Performance analytics
- [ ] Backtesting module
- [ ] Multi-channel support

## ⚠️ Disclaimer

**This bot is for educational purposes only.** Cryptocurrency trading carries significant risk. Never trade with money you cannot afford to lose. Always test thoroughly on testnet before using real funds.

- ❌ No guarantees of profit
- ❌ Past performance ≠ future results
- ❌ Use at your own risk
- ✅ Start small and test thoroughly
- ✅ Understand the code before running
- ✅ Monitor positions actively

## 📄 License

MIT License - See LICENSE file for details

## 🤝 Support

For issues or questions:
1. Check the troubleshooting section
2. Review logs for error messages
3. Verify configuration settings
4. Test on Binance testnet first

## 🎯 Quick Start Checklist

- [ ] Node.js v18+ installed
- [ ] Dependencies installed (`npm install`)
- [ ] `.env` file configured
- [ ] Telegram API credentials obtained
- [ ] Binance API keys created
- [ ] Tested on Binance testnet
- [ ] Web dashboard accessible
- [ ] Bot successfully connects to Telegram
- [ ] First test trade executed successfully

---

**Happy Trading! 🚀📈**
