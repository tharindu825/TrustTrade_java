# Quick Setup Guide

## Step-by-Step Installation

### 1. Install Node.js
Download and install Node.js v18+ from https://nodejs.org/

Verify installation:
```bash
node --version
npm --version
```

### 2. Install Dependencies
```bash
cd "f:/Onedrive/Tharindu/Softwares/Python Projects/Telegram Signal_Fetch/Hello_Traders/Java"
npm install
```

### 3. Create .env File
```bash
cp .env.example .env
```

### 4. Configure .env

Edit `.env` and add your credentials:

#### Telegram Settings
- Get from https://my.telegram.org/apps
```env
API_ID=12345678
API_HASH=abcdef1234567890abcdef1234567890
PHONE_NUMBER=+1234567890
CHANNEL_ID=@your_signal_channel
```

#### Binance Settings
- Get from Binance API Management
```env
TRADING_API_KEY=your_api_key_here
TRADING_SECRET_KEY=your_secret_key_here
MONITORING_API_KEY=your_monitoring_key_here
MONITORING_SECRET_KEY=your_monitoring_secret_here
```

#### Trading Mode
```env
TRADING_MODE=testnet  # Use testnet first!
```

### 5. First Run

```bash
npm start
```

You'll be prompted for:
1. Telegram verification code (sent to your phone)
2. 2FA password (if enabled)

### 6. Access Dashboard

Open browser: http://localhost:5000

## Testing Checklist

- [ ] Bot connects to Telegram successfully
- [ ] Bot connects to Binance successfully
- [ ] Web dashboard loads
- [ ] Signal is detected from channel
- [ ] Order is placed on Binance testnet
- [ ] TP/SL orders are placed after entry fills

## Common Issues

### "Missing required environment variables"
- Check all required fields in .env are filled
- No spaces around = sign
- No quotes around values

### "Failed to connect to Telegram"
- Verify API_ID and API_HASH
- Check phone number format (+countrycode)
- Try deleting session files and restarting

### "Binance authentication failed"
- Verify API keys are correct
- Check API key permissions (Futures enabled)
- Verify IP restrictions match your IP

## Next Steps

1. ✅ Test on Binance testnet first
2. ✅ Monitor first few trades closely
3. ✅ Adjust settings in .env as needed
4. ✅ Only switch to live trading when confident

## Support

Check README.md for detailed documentation and troubleshooting.
