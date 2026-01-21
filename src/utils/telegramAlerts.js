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
}

export default TelegramAlerts;
