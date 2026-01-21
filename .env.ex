# Telegram API credentials
API_ID=21934826
API_HASH=8f1aa9e3f63b934d0cde9c459bda8792
PHONE_NUMBER=+94766680474
CHANNEL_ID=2596425817:7931839598301278885

# TELEGRAM ALERTING CONFIGURATION
ALERT_BOT_TOKEN=7939248648:AAGtS9CK-2WtzzF7E5z_PNYqGJXXM1HWlNI
ALERT_CHAT_ID=5808477505
ALERT_LEVEL=ALL

# Binance API credentials
TRADING_API_KEY=OhuqXpr2zIE001BmWaLwba7dJQ5AMwuasZUDuJyebwTli0nifPnYDF8jbmxBNej1
TRADING_SECRET_KEY=SNXEi0saXlNE1lLcvp07gal0gkvV12LEGReARusa2AfWRVnrVpKt4RukyQ1k2YAU
MONITORING_API_KEY=GMPvPMykgGwUzS1PaZuNXX4hA59CbAvYvOzEdocWpN12JjQXJAu9jY0ca734u3Ku
MONITORING_SECRET_KEY=20M9PuxyM8hlQ2nhlKaqsX0Tz3JZL2y62miRN71Q54U5Yn9mQP21YhqVQGndqz5K

# Trading settings
TRADING_MODE=LIVE
MARGIN_TYPE=CROSS
MAX_OPEN_POSITIONS=1
MAX_OPEN_ENTRY_ORDERS=1
MIN_BALANCE=1.0
MARGIN_THRESHOLD=0.2
DEDUPLICATION_WINDOW=600
TARGET_MARGIN_PER_TRADE=0.5
DEFAULT_LEVERAGE=10
MAX_LEVERAGE=15
# Stop Loss & Take Profit Settings (ADAPTIVE SL - Updated Jan 16, 2026)
# INCREASED from 1.0% to 2.0% to survive fakeouts (~1.23% on DASHUSDT)
SL_PERCENTAGE=2.00          # Wider SL to handle volatile market conditions
# Trailing SL: Moves SL toward profit to lock gains. Lower value = more aggressive trailing.
TRAILING_SL_TRIGGER=0.05    # Trail after 5% profit move (lowered from 0.08 to lock profits earlier)
TP1_ROI=0.4                # 40% of profit target (50% of position)
TP2_ROI=1.0                # 100% of profit target (remaining 50%)

# Filter Settings - SCALPING OPTIMIZED (Updated for volatile coins)
MIN_FUNDING_RATE=-0.0050        # Wider range for scalping (was -0.0025)
MAX_FUNDING_RATE=0.0050         # Wider range for scalping (was 0.0025)
MAX_SPREAD_PERCENT=0.15         # Slightly higher for scalping (was 0.10)
MAX_ATR_PERCENT=12.0            # Allow volatile scalping coins (was 5.0) - CRITICAL
MAX_VOLATILITY_PERCENT=3.0      # Higher for scalping (was 2.0)
MAX_TRADES_PER_HOUR=8      # More trades for scalping (was 5)
MIN_RISK_REWARD=1.0        # Minimum 1:1 RR (Risk:Reward) - Now correctly calculated with 2% SL
ENABLE_VOLUME_FILTER=False
MIN_VOLUME_INCREASE_PERCENT=10.0
MAX_CANDLE_WICK_PERCENT=1.0
CANDLE_WICK_SKIP_MINUTES=5
TIME_FILTER_BUFFER_MINUTES=2
TRADE_COOLDOWN_SECONDS=300     # Faster for scalping (was 600)
MAX_ORDERBOOK_SPREAD_PERCENT=0.15  # Higher for scalping (was 0.1)

# API Rate Limiting (Added 2025-12-05 to prevent API bans)
API_REQUEST_DELAY=0.5              # Minimum seconds between API requests
MAX_REQUESTS_PER_MINUTE=60         # Maximum API requests per minute

# State Persistence
STATE_AUTOSAVE_INTERVAL=30

# Risk Management for Consecutive Losses
MAX_CONSECUTIVE_LOSSES=2           # Pause after this many consecutive losses
CONSECUTIVE_LOSS_PAUSE_HOURS=4     # Pause duration in hours after max losses reached
COUNT_LOSSES_ON_MANUAL_CLOSE=True  # If True, count manual closes with negative PNL as losses for streak/pause

# Filter Enable/Disable Toggles (SCALPING MODE)
ENABLE_RISK_REWARD_FILTER=True
ENABLE_VOLATILITY_FILTER=True
ENABLE_SPREAD_FILTER=True
ENABLE_TIME_FILTER=False
ENABLE_TREND_FILTER=False          # ⭐ DISABLED for more signals (was True)
ENABLE_CANDLE_WICK_FILTER=False
ENABLE_VOLUME_SPIKE_DETECTION=False

# ========================================
# NEW FILTER STRATEGIES (Start Disabled for Testing)
# ========================================

# Technical Indicator Filter Settings (STRATEGY 1)
ENABLE_TECHNICAL_INDICATOR_FILTER=False  # Set to True after testing in TESTNET
RSI_OVERBOUGHT=80
RSI_OVERSOLD=20
REQUIRE_EMA_ALIGNMENT=True

# Signal Validation with Indicators (Simplified RSI Filter)
ENABLE_RSI_FILTER=False
EMA_PERIOD=20

# Dynamic Position Sizing Settings (STRATEGY 2)
ENABLE_DYNAMIC_SIZING=False  # Set to True after testing
ENABLE_ATR_SIZING=False  # Set to True after testing
MAX_RISK_PER_TRADE_PERCENT=1.0  # Never risk more than 1% per trade

# Symbol Blacklist Settings (STRATEGY 3)
ENABLE_SYMBOL_BLACKLIST=True  # Set to True after testing
MIN_SYMBOL_WIN_RATE=0.4  # 40% minimum win rate
MIN_TRADES_FOR_BLACKLIST=5  # Need 5 trades before blacklisting
BLACKLIST_DURATION_MINUTES=2880  # 24 hours

# Adaptive SL/TP Settings (STRATEGY 4)
ENABLE_ATR_SL=False  # Set to True after testing
ATR_SL_MULTIPLIER=1.5  # SL distance = ATR * 1.5
BREAKEVEN_TRIGGER_PCT=999  # Move SL to breakeven after 0.5% profit

# Direction Validation Filter (Prevent wrong-direction signals)
ENABLE_DIRECTION_VALIDATION=True         # Enable to validate signal direction against trend indicators
DIRECTION_RSI_PERIOD=14                  # RSI period (default 14)
DIRECTION_EMA_PERIOD=20                  # EMA period for trend (default 20)
DIRECTION_MACD_FAST=12                   # MACD fast period (default 12)
DIRECTION_MACD_SLOW=26                   # MACD slow period (default 26)
DIRECTION_MACD_SIGNAL=9                  # MACD signal period (default 9)
DIRECTION_RSI_BULLISH_THRESHOLD=50       # RSI > this for bullish (default 50)
DIRECTION_RSI_BEARISH_THRESHOLD=50       # RSI < this for bearish (default 50)
DIRECTION_KLINES_LIMIT=100               # Number of recent 1m candles to fetch
DIRECTION_ALERT_ON_SKIP=True             # Send Telegram alert when skipping a misaligned signal