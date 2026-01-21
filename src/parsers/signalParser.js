import logger from '../utils/logger.js';

/**
 * Signal Parser - Parses Telegram messages to extract trading signals
 */
class TelegramSignalParser {
    constructor() {
        // Patterns for the new signal format: 🔥#BEAT/USDT (Short📉, x20)🔥
        this.newPatterns = {
            signalHeader: /#([A-Z0-9]+)\/USDT\s*\(\s*(Long|Short)[^,]*,\s*x(\d+)\s*\)/i,
            entryPrice: /Entry\s*-\s*([0-9.]+)/i,
            tpLevels: /([0-9.]+)\s*\(\d+%\s*of\s*profit\)/gi,
            tpPrice: /Price\s*-\s*([0-9.]+)/i,
            tpProfit: /Profit\s*-\s*(\d+)%/i
        };

        // Patterns for the old signal format (backward compatibility)
        this.oldPatterns = {
            coin: /Coin pair:\s*([A-Z0-9]+)/i,
            direction: /Order:\s*(buy|sell)/i
        };
    }

    /**
     * Normalize text by removing emojis and special characters
     */
    _normalizeText(text) {
        const replacements = {
            '📌': '', '⭕️': '', '📈': '', '📉': '', '✴️': '', '⚠️': '',
            '🟢': '', '🔴': '', '⭐': '', '🚀': '', '💠': '',
            '🇱🇰': '', '🔥': '', '🔔': '', '✅': '', '⏰': '', '⚠': ''
        };

        let normalized = text;
        for (const [emoji, replacement] of Object.entries(replacements)) {
            normalized = normalized.replace(new RegExp(emoji, 'g'), replacement);
        }

        // Remove any remaining non-ASCII characters
        normalized = normalized.replace(/[^\x00-\x7F]+/g, ' ');
        return normalized;
    }

    /**
     * Parse Telegram message to extract trading signal
     */
    parseMessage(text, timestamp = Date.now()) {
        try {
            const normalizedText = this._normalizeText(text);
            logger.info(`Parsing normalized message: ${normalizedText.substring(0, 200)}...`);

            // Try to parse new signal format first
            const signalHeaderMatch = normalizedText.match(this.newPatterns.signalHeader);

            if (signalHeaderMatch) {
                const symbolName = signalHeaderMatch[1].toUpperCase();
                const directionStr = signalHeaderMatch[2].toUpperCase();
                const leverageValue = signalHeaderMatch[3];

                const coin = `${symbolName}USDT`;
                const direction = directionStr === 'LONG' ? 'LONG' : 'SHORT';
                const leverage = `${leverageValue}X`;

                // Extract entry price
                const entryMatch = normalizedText.match(this.newPatterns.entryPrice);
                const entryPrice = entryMatch ? parseFloat(entryMatch[1]) : null;

                if (entryPrice) {
                    // Extract all TP levels
                    const tpMatches = [...normalizedText.matchAll(this.newPatterns.tpLevels)];
                    const targets = tpMatches.map(match => parseFloat(match[1])).filter(price => !isNaN(price));

                    logger.info(`New signal format detected: Coin=${coin}, Direction=${direction}, Leverage=${leverage}, Entry=${entryPrice}`);
                    if (targets.length > 0) {
                        logger.info(`Extracted ${targets.length} TP levels: ${targets.join(', ')}`);
                    }

                    return {
                        coin,
                        direction,
                        entryPrices: [entryPrice],
                        targets,
                        leverage,
                        isTakeProfit: false,
                        profit: 0.0,
                        timestamp,
                        message: text
                    };
                } else {
                    // Check if this is a TP signal
                    const tpPriceMatch = normalizedText.match(this.newPatterns.tpPrice);
                    const tpProfitMatch = normalizedText.match(this.newPatterns.tpProfit);

                    if (tpPriceMatch && tpProfitMatch) {
                        const tpPrice = parseFloat(tpPriceMatch[1]);
                        const profitPercent = parseFloat(tpProfitMatch[1]);

                        logger.info(`TP signal detected: Coin=${coin}, Price=${tpPrice}, Profit=${profitPercent}%`);

                        return {
                            coin,
                            direction,
                            entryPrices: [],
                            targets: [tpPrice],
                            leverage,
                            isTakeProfit: true,
                            profit: profitPercent,
                            timestamp,
                            message: text
                        };
                    } else {
                        logger.warn(`New format detected but no entry price or TP data found for ${coin}`);
                        return null;
                    }
                }
            }

            // Try old format
            const coinMatch = normalizedText.match(this.oldPatterns.coin);
            const directionMatch = normalizedText.match(this.oldPatterns.direction);

            if (coinMatch && directionMatch) {
                let coinName = coinMatch[1].toUpperCase();
                coinName = coinName.replace('.P', '').replace('.PERP', '');
                const coin = coinName.endsWith('USDT') ? coinName : `${coinName}USDT`;

                const directionRaw = directionMatch[1].toUpperCase();
                const direction = directionRaw === 'BUY' ? 'LONG' : 'SHORT';

                logger.info(`Old signal format detected: Coin=${coin}, Direction=${direction}`);

                return {
                    coin,
                    direction,
                    entryPrices: [],
                    targets: [],
                    leverage: `${process.env.DEFAULT_LEVERAGE || 20}X`,
                    isTakeProfit: false,
                    profit: 0.0,
                    timestamp,
                    message: text
                };
            }

            logger.warn('Message does not match any known signal format');
            return null;

        } catch (error) {
            logger.error(`Parsing error: ${error.message}`, error);
            return null;
        }
    }
}

export default TelegramSignalParser;
