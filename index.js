import dotenv from 'dotenv';
import logger from './src/utils/logger.js';
import TelegramSignalBot from './src/telegram/telegramClient.js';
import BinanceTrader from './src/binance/binanceTrader.js';
import TradingStrategy from './src/strategy/tradingStrategy.js';
import WebDashboard from './src/web/dashboard.js';
import TelegramAlerts from './src/utils/telegramAlerts.js';
import PositionTracker from './src/utils/positionTracker.js';

// Load environment variables
dotenv.config();

/**
 * Main Application Class
 */
class TrustTradeBot {
    constructor() {
        this.config = process.env;
        this.binanceTrader = null;
        this.tradingStrategy = null;
        this.telegramBot = null;
        this.webDashboard = null;
        this.alerts = null;
        this.positionTracker = null;
        this.isRunning = false;
    }

    /**
     * Validate required environment variables
     */
    validateConfig() {
        const required = [
            'API_ID',
            'API_HASH',
            'PHONE_NUMBER',
            'CHANNEL_ID',
            'TRADING_API_KEY',
            'TRADING_SECRET_KEY',
            'MONITORING_API_KEY',
            'MONITORING_SECRET_KEY',
            'TRADING_MODE'
        ];

        const missing = required.filter(key => !this.config[key]);

        if (missing.length > 0) {
            throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
        }

        logger.info('✅ Configuration validated');
    }

    /**
     * Initialize all components
     */
    async initialize() {
        try {
            logger.info('🚀 Starting TrustTrade Bot...');

            // Validate configuration
            this.validateConfig();

            // Initialize Binance trader
            logger.info('Initializing Binance trader...');
            this.binanceTrader = new BinanceTrader(this.config);
            await this.binanceTrader.initialize();

            // Initialize trading strategy
            logger.info('Initializing trading strategy...');
            this.tradingStrategy = new TradingStrategy(this.binanceTrader, this.config);

            // Initialize Telegram alerts
            this.alerts = new TelegramAlerts(this.config);

            // Initialize position tracker
            this.positionTracker = new PositionTracker(this.binanceTrader, this.alerts);

            // Link position tracker to trading strategy
            this.tradingStrategy.setPositionTracker(this.positionTracker);

            // Initialize web dashboard
            logger.info('Starting web dashboard...');
            this.webDashboard = new WebDashboard(this.binanceTrader, this.config);
            this.webDashboard.start();

            // Initialize Telegram bot
            logger.info('Initializing Telegram client...');
            this.telegramBot = new TelegramSignalBot(
                this.config,
                this.handleSignal.bind(this)
            );
            await this.telegramBot.connect();

            logger.info('✅ All components initialized successfully');
            this.isRunning = true;

            // Start position tracker
            this.positionTracker.startMonitoring();

            // Send startup alert
            await this.alerts.sendStartupAlert();

        } catch (error) {
            logger.error(`Failed to initialize bot: ${error.message}`, error);
            if (this.alerts) {
                await this.alerts.sendErrorAlert(error, 'Bot Initialization');
            }
            throw error;
        }
    }

    /**
     * Handle incoming signal from Telegram
     */
    async handleSignal(signal) {
        try {
            logger.info(`📨 Received signal: ${signal.coin} ${signal.direction}`);

            // Check if this is an opposite direction signal
            if (signal.isTakeProfit && signal.message.includes('Closed due to opposite direction')) {
                await this.tradingStrategy.handleOppositeDirection(signal);
                return;
            }

            // Ignore regular TP signals
            if (signal.isTakeProfit) {
                logger.info(`Ignoring TP signal for ${signal.coin}. Bot uses own TP system.`);
                return;
            }

            // Process regular entry signal
            const success = await this.tradingStrategy.handleSignal(signal);

            if (success) {
                logger.info(`✅ Signal processed successfully for ${signal.coin}`);
            } else {
                logger.warn(`⚠️ Signal processing failed for ${signal.coin}`);
            }

        } catch (error) {
            logger.error(`Error handling signal: ${error.message}`, error);
        }
    }

    /**
     * Start listening to Telegram channel
     */
    async start() {
        try {
            if (!this.isRunning) {
                await this.initialize();
            }

            logger.info('👂 Starting to listen for signals...');
            await this.telegramBot.listenToChannel();

            // Keep the process alive
            await new Promise((resolve) => {
                // This promise never resolves, keeping the process running
                // It will be interrupted by SIGINT/SIGTERM signals
            });

        } catch (error) {
            logger.error(`Error starting bot: ${error.message}`, error);
            await this.shutdown();
            process.exit(1);
        }
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        logger.info('🛑 Shutting down bot...');

        try {
            // Stop position tracker
            if (this.positionTracker) {
                this.positionTracker.stopMonitoring();
            }

            // Disconnect Telegram
            if (this.telegramBot) {
                await this.telegramBot.disconnect();
            }

            // Stop web dashboard
            if (this.webDashboard) {
                this.webDashboard.stop();
            }

            // Send shutdown alert
            if (this.alerts) {
                await this.alerts.sendShutdownAlert();
            }

            logger.info('✅ Bot shutdown complete');
            this.isRunning = false;

        } catch (error) {
            logger.error(`Error during shutdown: ${error.message}`, error);
        }
    }
}

// Create bot instance
const bot = new TrustTradeBot();

// Handle process termination
process.on('SIGINT', async () => {
    logger.info('\n📛 Received SIGINT signal');
    await bot.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('\n📛 Received SIGTERM signal');
    await bot.shutdown();
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`, error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Start the bot
bot.start().catch(error => {
    logger.error(`Fatal error: ${error.message}`, error);
    process.exit(1);
});
