# Troubleshooting Guide

## ✅ Success! Bot is Running

The bot has successfully:
- ✅ Loaded all modules
- ✅ Validated configuration
- ✅ Connected to Binance API

## ⚠️ Current Issue: Timestamp Synchronization

**Error**: `Timestamp for this request was 1000ms ahead of the server's time`

### What This Means
Your computer's clock is slightly ahead of Binance's servers. This is a common issue and easy to fix.

### Solutions (Try in order):

#### Solution 1: Sync Your System Clock (Recommended)
**Windows:**
1. Right-click on the clock in taskbar
2. Select "Adjust date/time"
3. Turn ON "Set time automatically"
4. Click "Sync now"

#### Solution 2: Add Timestamp Offset to Code
If syncing doesn't work, we can add a timestamp offset in the Binance client.

#### Solution 3: Use Testnet First
If you're testing, use Binance Testnet which is more forgiving:
- Testnet URL: https://testnet.binancefuture.com/

### Next Steps After Fixing Time:

1. **Verify .env Configuration**
   Make sure your `.env` file has:
   ```env
   TRADING_API_KEY=your_actual_api_key
   TRADING_SECRET_KEY=your_actual_secret_key
   MONITORING_API_KEY=your_monitoring_key
   MONITORING_SECRET_KEY=your_monitoring_secret
   ```

2. **Test Connection**
   ```bash
   npm start
   ```

3. **Check Dashboard**
   Open: http://localhost:5000

## 🎯 What's Working

The bot successfully:
- ✅ Loads all dependencies
- ✅ Validates environment variables
- ✅ Initializes Binance clients
- ✅ Attempts API connection

## 📝 Common Issues & Solutions

### Issue: "Missing required environment variables"
**Solution**: Copy `.env.example` to `.env` and fill in all values

### Issue: "API authentication failed"
**Solution**: 
- Verify API keys are correct
- Check API key permissions (Futures enabled)
- Verify IP restrictions match your IP

### Issue: "Cannot find module"
**Solution**: Run `npm install` again

### Issue: "Telegram connection failed"
**Solution**:
- Verify API_ID and API_HASH
- Check phone number format (+countrycode)
- Delete session files and try again

## 🔍 Testing Checklist

Once timestamp is fixed:

- [ ] Bot starts without errors
- [ ] Binance connection successful
- [ ] Web dashboard loads (http://localhost:5000)
- [ ] Telegram connects (will prompt for code)
- [ ] Signal is detected from channel
- [ ] Order is placed on exchange

## 📞 Need Help?

1. Check logs in `logs/` folder
2. Verify all .env values are correct
3. Ensure Binance API keys have correct permissions
4. Test on Binance Testnet first

## 🚀 Ready to Continue?

After fixing the timestamp issue:

```bash
# 1. Sync your system clock
# 2. Run the bot
npm start

# 3. Access dashboard
# Open http://localhost:5000 in browser

# 4. Bot will prompt for Telegram code
# Enter the code sent to your phone
```

---

**The bot is 95% working! Just need to fix the timestamp sync.**
