import logger from './logger.js';

/**
 * Telegram Alert System - Sends notifications via Telegram Bot
 */
class TelegramAlerts {
    constructor(config) {
        this.botToken = config.ALERT_BOT_TOKEN;
        this.chatId = config.ALERT_CHAT_ID;
        this.alertLevel = config.ALERT_LEVEL || 'ALL';
        this.enabled = this.botToken && this.chatId;
        
        // Alert toggles
        this.alertOnValidationPass = config.ALERT_ON_VALIDATION_PASS === 'true';
        this.alertOnValidationFail = config.ALERT_ON_VALIDATION_FAIL === 'true';
        this.alertOnEntryFill = config.ALERT_ON_ENTRY_FILL === 'true';
        this.alertOnSLHit = config.ALERT_ON_SL_HIT === 'true';
        this.alertOnTPHit = config.ALERT_ON_TP_HIT === 'true';

        if (!this.enabled) {
            logger.warn('Telegram alerts disabled - missing ALERT_BOT_TOKEN or ALERT_CHAT_ID');
        }
    }

    /**
     * Send alert message to Telegram
     */
    async sendAlert(message, level = 'INFO') {
        if (!this.enabled) {
            return;
        }

        // Check if we should send this alert based on level
        if (this.alertLevel === 'ERRORS' && level !== 'ERROR') {
            return;
        }

        if (this.alertLevel === 'NONE') {
            return;
        }

        try {
            const emoji = this.getLevelEmoji(level);
            const formattedMessage = `${emoji} *${level}*\n\n${message}`;

            const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    chat_id: this.chatId,
                    text: formattedMessage,
                    parse_mode: 'Markdown',
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                logger.error(`Failed to send Telegram alert: ${JSON.stringify(error)}`);
            }
        } catch (error) {
            logger.error(`Error sending Telegram alert: ${error.message}`);
        }
    }

    /**
     * Get emoji for log level
     */
    getLevelEmoji(level) {
        const emojis = {
            'INFO': 'ℹ️',
            'SUCCESS': '✅',
            'WARN': '⚠️',
            'WARNING': '⚠️',
            'ERROR': '❌',
            'TRADE': '💰',
            'SIGNAL': '📊',
        };
        return emojis[level] || 'ℹ️';
    }

    /**
     * Send startup alert
     */
    async sendStartupAlert() {
        await this.sendAlert(
            '🚀 *TrustTrade Bot Started*\n\n' +
            `Time: ${new Date().toLocaleString()}\n` +
            'Status: All systems operational',
            'SUCCESS'
        );
    }

    /**
     * Send shutdown alert
     */
    async sendShutdownAlert() {
        await this.sendAlert(
            '🛑 *TrustTrade Bot Stopped*\n\n' +
            `Time: ${new Date().toLocaleString()}\n` +
            'Status: Bot shutdown complete',
            'INFO'
        );
    }

    /**
     * Send trade alert
     */
    async sendTradeAlert(signal, action) {
        const message =
            `📊 *${action} Trade*\n\n` +
            `Symbol: ${signal.coin}\n` +
            `Direction: ${signal.direction}\n` +
            `Entry: ${signal.entryPrices.join(', ')}\n` +
            `Leverage: ${signal.leverage}`;

        await this.sendAlert(message, 'TRADE');
    }

    /**
     * Send error alert
     */
    async sendErrorAlert(error, context = '') {
        const message =
            `❌ *Error Occurred*\n\n` +
            `Context: ${context}\n` +
            `Error: ${error.message || error}`;

        await this.sendAlert(message, 'ERROR');
    }

    /**
     * Send trend validation alert
     */
    async sendValidationAlert(symbol, direction, passed, reason, indicators = {}) {
        if (passed && !this.alertOnValidationPass) return;
        if (!passed && !this.alertOnValidationFail) return;

        const emoji = passed ? '✅' : '⚠️';
        const status = passed ? 'PASSED' : 'SKIPPED';
        const level = passed ? 'SUCCESS' : 'WARNING';

        let message = `${emoji} *Signal ${status}: ${symbol} ${direction}*\n\n`;
        message += `Reason: ${reason}\n`;
        
        if (indicators.rsi) {
            message += `\nIndicators:\n`;
            message += `• RSI: ${indicators.rsi}\n`;
            message += `• EMA: ${indicators.ema}\n`;
            message += `• MACD: ${indicators.macd}\n`;
            if (indicators.adx && indicators.adx !== 'N/A') {
                message += `• ADX: ${indicators.adx}\n`;
            }
            if (indicators.volumeRatio && indicators.volumeRatio !== 'N/A') {
                message += `• Volume: ${indicators.volumeRatio}x\n`;
            }
        }

        await this.sendAlert(message, level);
    }

    /**
     * Send entry fill alert
     */
    async sendEntryFillAlert(symbol, direction, entryPrice, quantity, leverage, positionValue) {
        if (!this.alertOnEntryFill) return;

        const message =
            `✅ *Entry Order Filled: ${symbol}*\n\n` +
            `Direction: ${direction}\n` +
            `Entry Price: $${entryPrice}\n` +
            `Quantity: ${quantity}\n` +
            `Leverage: ${leverage}x\n` +
            `Position Value: $${positionValue.toFixed(2)}`;

        await this.sendAlert(message, 'SUCCESS');
    }

    /**
     * Send SL hit alert
     */
    async sendSLHitAlert(symbol, entryPrice, exitPrice, pnl, pnlPercent, roiPercent, duration) {
        if (!this.alertOnSLHit) return;

        const message =
            `🔴 *SL HIT: ${symbol}*\n\n` +
            `Entry: $${entryPrice}\n` +
            `Exit: $${exitPrice}\n` +
            `Loss: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n` +
            `ROI: ${roiPercent.toFixed(2)}%\n` +
            `Duration: ${duration}`;

        await this.sendAlert(message, 'ERROR');
    }

    /**
     * Send TP hit alert
     */
    async sendTPHitAlert(symbol, tpLevel, entryPrice, exitPrice, profit, profitPercent, remaining = null) {
        if (!this.alertOnTPHit) return;

        const emoji = tpLevel === 'TP2' ? '🎉' : '💰';
        let message =
            `${emoji} *${tpLevel} Hit: ${symbol}*\n\n` +
            `Entry: $${entryPrice}\n` +
            `${tpLevel}: $${exitPrice}\n` +
            `Profit: $${profit.toFixed(2)} (+${profitPercent.toFixed(2)}%)\n`;

        if (remaining !== null) {
            message += `Remaining: ${remaining}% position active`;
        } else {
            message += `Trade Complete! 🎊`;
        }

        await this.sendAlert(message, 'SUCCESS');
    }
}

export default TelegramAlerts;
