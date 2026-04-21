import logger from '../utils/logger.js';

/**
 * Signal Parser - Parses Telegram messages to extract trading signals
 *
 * Supports two formats:
 *
 * NEW FORMAT (primary):
 *   Pairs:  SCRT/USDT
 *   👉 Trade Type = SHORT 🔴
 *   👉 Leverage :- 20x            ← ignored; leverage comes from .env DEFAULT_LEVERAGE
 *   ⚡ Entry = [ 0.1125 TO 0.1122 ]
 *   ❌ StopLoss :- 0.1167
 *   ✅ Take profit = [ 0.1109, 0.1095, 0.1080, 0.1066, 0.1050, 0.1032 ]
 *                                  ← ignored; TP comes from .env TP1_ROI / TP2_ROI
 *
 * OLD FORMAT (fallback):
 *   🔥#BEAT/USDT (Short📉, x20)🔥
 *   Entry - 0.xxxx
 *   0.yyyy (50% of profit) ...
 */
class TelegramSignalParser {
    constructor() {
        // ── NEW FORMAT PATTERNS ──────────────────────────────────────────────
        this.newFormatPatterns = {
            // "Pairs:  SCRT/USDT" or "Pairs: BTC/USDT"
            pairsSymbol: /Pairs\s*:\s*([A-Z0-9]+)\s*\/\s*USDT/i,

            // "Trade Type = SHORT 🔴" or "Trade Type = LONG"
            tradeType: /Trade\s+Type\s*=\s*(LONG|SHORT)/i,

            // "Entry = [ 0.1125 TO 0.1122 ]"
            entryRange: /Entry\s*=\s*\[\s*([0-9.]+)\s+TO\s+([0-9.]+)\s*\]/i,

            // "StopLoss :- 0.1167"
            stopLoss: /StopLoss\s*[:\-]+\s*([0-9.]+)/i,

            // "Take profit = [ 0.1109, 0.1095, ... ]" — parsed for logging only
            takeProfit: /Take\s+profit\s*=\s*\[\s*([0-9.,\s]+)\]/i,
        };

        // ── OLD FORMAT PATTERNS (backward compatibility) ─────────────────────
        this.oldFormatPatterns = {
            // "#BEAT/USDT (Short📉, x20)" after emoji normalization
            signalHeader: /#([A-Z0-9]+)\/USDT\s*\(\s*(Long|Short)[^,]*,\s*x(\d+)\s*\)/i,
            entryPrice: /Entry\s*-\s*([0-9.]+)/i,
            tpLevels: /([0-9.]+)\s*\(\d+%\s*of\s*profit\)/gi,
            tpPrice: /Price\s*-\s*([0-9.]+)/i,
            tpProfit: /Profit\s*-\s*(\d+)%/i,
        };

        // ── LEGACY OLD FORMAT ────────────────────────────────────────────────
        this.legacyPatterns = {
            coin: /Coin pair:\s*([A-Z0-9]+)/i,
            direction: /Order:\s*(buy|sell)/i,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalize text by removing emojis and special characters.
     * Used only for the old format path.
     */
    _normalizeText(text) {
        const replacements = {
            '📌': '', '⭕️': '', '📈': '', '📉': '', '✴️': '', '⚠️': '',
            '🟢': '', '🔴': '', '⭐': '', '🚀': '', '💠': '',
            '🇱🇰': '', '🔥': '', '🔔': '', '✅': '', '⏰': '', '⚠': '',
            '👉': '', '⚡': '', '❌': '',
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
     * Validate that the stop-loss price makes sense for the given direction.
     *
     * SHORT trade → SL must be ABOVE entry (SL > entry, price rises against us)
     * LONG  trade → SL must be BELOW entry (SL < entry, price falls against us)
     *
     * Returns true if valid, false if illogical.
     */
    _validateStopLossDirection(direction, entryPrice, slPrice) {
        if (direction === 'SHORT' && slPrice <= entryPrice) {
            logger.warn(
                `⚠️ SL direction mismatch: SHORT trade but SL (${slPrice}) is NOT above entry (${entryPrice}). ` +
                `Signal may be malformed.`
            );
            return false;
        }
        if (direction === 'LONG' && slPrice >= entryPrice) {
            logger.warn(
                `⚠️ SL direction mismatch: LONG trade but SL (${slPrice}) is NOT below entry (${entryPrice}). ` +
                `Signal may be malformed.`
            );
            return false;
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: PARSE MESSAGE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Parse a Telegram message and return a structured signal object, or null
     * if the message does not match any known format.
     *
     * @param {string} text       - Raw message text
     * @param {number} timestamp  - Unix ms timestamp of message
     * @returns {object|null}     - Signal object or null
     */
    parseMessage(text, timestamp = Date.now()) {
        try {
            logger.info(`Parsing message (${text.length} chars): ${text.substring(0, 120).replace(/\n/g, ' ')}...`);

            // ── 1. Try NEW FORMAT ──────────────────────────────────────────
            const newSignal = this._parseNewFormat(text, timestamp);
            if (newSignal) return newSignal;

            // ── 2. Try OLD FORMAT ──────────────────────────────────────────
            const normalizedText = this._normalizeText(text);
            const oldSignal = this._parseOldFormat(normalizedText, text, timestamp);
            if (oldSignal) return oldSignal;

            // ── 3. Try LEGACY FORMAT ───────────────────────────────────────
            const legacySignal = this._parseLegacyFormat(normalizedText, text, timestamp);
            if (legacySignal) return legacySignal;

            logger.warn('Message does not match any known signal format');
            return null;

        } catch (error) {
            logger.error(`Parsing error: ${error.message}`, error);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: NEW FORMAT PARSER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Parse the new channel signal format:
     *
     *   Pairs:  SCRT/USDT
     *   Trade Type = SHORT
     *   Entry = [ 0.1125 TO 0.1122 ]
     *   StopLoss :- 0.1167
     *   Take profit = [ 0.1109, ... ]   ← logged but ignored; env TPs are used
     */
    _parseNewFormat(text, timestamp) {
        const p = this.newFormatPatterns;

        // ── Symbol ────────────────────────────────────────────────────────
        const pairsMatch = text.match(p.pairsSymbol);
        if (!pairsMatch) return null; // Not new format

        const symbolName = pairsMatch[1].toUpperCase();
        const coin = `${symbolName}USDT`;

        // ── Direction ─────────────────────────────────────────────────────
        const typeMatch = text.match(p.tradeType);
        if (!typeMatch) {
            logger.warn(`New format: "Pairs:" line found for ${coin} but no "Trade Type" found. Skipping.`);
            return null;
        }
        const direction = typeMatch[1].toUpperCase(); // 'LONG' or 'SHORT'

        // ── Entry Range → Average ─────────────────────────────────────────
        const entryMatch = text.match(p.entryRange);
        if (!entryMatch) {
            logger.warn(`New format: No "Entry = [ X TO Y ]" found for ${coin}. Skipping.`);
            return null;
        }
        const entryHigh = parseFloat(entryMatch[1]);
        const entryLow  = parseFloat(entryMatch[2]);

        if (isNaN(entryHigh) || isNaN(entryLow)) {
            logger.warn(`New format: Could not parse entry range values for ${coin}. Skipping.`);
            return null;
        }

        const entryAvg = parseFloat(((entryHigh + entryLow) / 2).toFixed(10));
        logger.info(`Entry range: ${entryHigh} TO ${entryLow} → Average: ${entryAvg}`);

        // ── Stop Loss ─────────────────────────────────────────────────────
        const slMatch = text.match(p.stopLoss);
        if (!slMatch) {
            logger.warn(`New format: No "StopLoss" found for ${coin}. Skipping.`);
            return null;
        }
        const stopLoss = parseFloat(slMatch[1]);

        if (isNaN(stopLoss)) {
            logger.warn(`New format: Could not parse StopLoss value for ${coin}. Skipping.`);
            return null;
        }

        // ── SL Direction Validation ───────────────────────────────────────
        const slValid = this._validateStopLossDirection(direction, entryAvg, stopLoss);
        if (!slValid) {
            logger.warn(
                `New format: SL direction invalid for ${coin} (${direction}). ` +
                `Entry avg=${entryAvg}, SL=${stopLoss}. Signal will still be forwarded with a warning.`
            );
            // We do NOT discard the signal — just warn. The strategy can decide.
        }

        // ── Take Profit (log only) ────────────────────────────────────────
        const tpMatch = text.match(p.takeProfit);
        if (tpMatch) {
            const signalTPs = tpMatch[1]
                .split(',')
                .map(s => parseFloat(s.trim()))
                .filter(n => !isNaN(n));
            logger.info(
                `New format: Signal TP levels (ignored — env ROI used): [${signalTPs.join(', ')}]`
            );
        } else {
            logger.info(`New format: No TP levels in message for ${coin}. Env ROI will be used.`);
        }

        logger.info(
            `✅ New format parsed: coin=${coin}, direction=${direction}, ` +
            `entry=${entryAvg} (avg of ${entryHigh}–${entryLow}), ` +
            `stopLoss=${stopLoss} | Leverage & TP from .env`
        );

        return {
            coin,
            direction,               // 'LONG' | 'SHORT'
            entryPrices: [entryAvg], // Averaged entry → limit order price
            stopLoss,                // Exact SL from signal
            targets: [],             // Always empty → forces env-based TP in strategy
            leverage: null,          // Ignored; strategy uses DEFAULT_LEVERAGE from .env
            isTakeProfit: false,
            profit: 0.0,
            timestamp,
            message: text,
            slValid,                 // true/false — strategy can check this flag
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: OLD FORMAT PARSER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Parse the old channel signal format (kept for backward compat):
     *   🔥#BEAT/USDT (Short📉, x20)🔥
     *   Entry - 0.xxxx
     *   0.yyyy (50% of profit) ...
     */
    _parseOldFormat(normalizedText, originalText, timestamp) {
        const p = this.oldFormatPatterns;
        const signalHeaderMatch = normalizedText.match(p.signalHeader);
        if (!signalHeaderMatch) return null;

        const symbolName   = signalHeaderMatch[1].toUpperCase();
        const directionStr = signalHeaderMatch[2].toUpperCase();
        const coin         = `${symbolName}USDT`;
        const direction    = directionStr === 'LONG' ? 'LONG' : 'SHORT';
        // Note: old format leverage is also ignored per requirements
        // leverage always comes from DEFAULT_LEVERAGE env

        // Extract entry price
        const entryMatch = normalizedText.match(p.entryPrice);
        const entryPrice = entryMatch ? parseFloat(entryMatch[1]) : null;

        if (entryPrice) {
            // Extract all TP levels (channel-defined, used for logging only now)
            const tpMatches = [...normalizedText.matchAll(p.tpLevels)];
            const targets   = tpMatches.map(m => parseFloat(m[1])).filter(n => !isNaN(n));

            logger.info(
                `Old format parsed: coin=${coin}, direction=${direction}, entry=${entryPrice}` +
                (targets.length ? `, channelTPs=[${targets.join(', ')}] (ignored)` : '')
            );

            return {
                coin,
                direction,
                entryPrices: [entryPrice],
                stopLoss: null,     // Old format has no explicit SL → strategy uses SL_PERCENTAGE
                targets: [],        // Always empty → env-based TP
                leverage: null,     // Always from DEFAULT_LEVERAGE env
                isTakeProfit: false,
                profit: 0.0,
                timestamp,
                message: originalText,
                slValid: true,
            };
        }

        // Check if it's a TP update signal from old format
        const tpPriceMatch  = normalizedText.match(p.tpPrice);
        const tpProfitMatch = normalizedText.match(p.tpProfit);

        if (tpPriceMatch && tpProfitMatch) {
            const tpPrice      = parseFloat(tpPriceMatch[1]);
            const profitPercent = parseFloat(tpProfitMatch[1]);

            logger.info(`Old format TP signal: coin=${coin}, tpPrice=${tpPrice}, profit=${profitPercent}%`);

            return {
                coin,
                direction,
                entryPrices: [],
                stopLoss: null,
                targets: [tpPrice],
                leverage: null,
                isTakeProfit: true,
                profit: profitPercent,
                timestamp,
                message: originalText,
                slValid: true,
            };
        }

        logger.warn(`Old format header found for ${coin} but no entry price or TP data found.`);
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: LEGACY FORMAT PARSER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Parse the legacy format:
     *   Coin pair: BTCUSDT
     *   Order: buy
     */
    _parseLegacyFormat(normalizedText, originalText, timestamp) {
        const p = this.legacyPatterns;
        const coinMatch      = normalizedText.match(p.coin);
        const directionMatch = normalizedText.match(p.direction);

        if (!coinMatch || !directionMatch) return null;

        let coinName = coinMatch[1].toUpperCase();
        coinName     = coinName.replace('.P', '').replace('.PERP', '');
        const coin   = coinName.endsWith('USDT') ? coinName : `${coinName}USDT`;

        const directionRaw = directionMatch[1].toUpperCase();
        const direction    = directionRaw === 'BUY' ? 'LONG' : 'SHORT';

        logger.info(`Legacy format parsed: coin=${coin}, direction=${direction}`);

        return {
            coin,
            direction,
            entryPrices: [],
            stopLoss: null,
            targets: [],
            leverage: null,
            isTakeProfit: false,
            profit: 0.0,
            timestamp,
            message: originalText,
            slValid: true,
        };
    }
}

export default TelegramSignalParser;
