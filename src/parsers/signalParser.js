import logger from '../utils/logger.js';

/**
 * Signal Parser - Parses Telegram messages to extract trading signals
 *
 * Supports the following signal formats:
 *
 * Format 1 - SCALP TRADE (primary):
 * ✅ SCALP TRADE - ENS
 * 👉 ENTRY - 6.22$ TO 6.44$
 * 👉 DIRECTION - SHORT
 * 👉 TARGET - $6.20$ 6.12$ 6.02$ $5.90 5.871$
 * 👉 SL - $6.56
 * 🎰 LEVERAGE - 10x
 * Trader - ORANGE
 *
 * Format 2 - Legacy (#COIN/USDT header):
 * 🔥#BEAT/USDT (Short📉, x20)🔥
 * Entry - 0.123
 * 0.120 (10% of profit) ...
 *
 * Format 3 - Old (Coin pair / Order):
 * Coin pair: BTCUSDT
 * Order: buy
 */
class TelegramSignalParser {
    constructor() {
        // ── Format 1: SCALP TRADE ────────────────────────────────────────────────
        this.scalpPatterns = {
            // e.g.  "SCALP TRADE - ENS"  or  "SCALP TRADE- ENSUSDT"
            header:    /SCALP\s+TRADE\s*[-–]\s*([A-Z0-9]+)/i,

            // Entry range — supports both separators:
            //   Old:  "ENTRY - 6.22$ TO 6.44$"   or  "ENTRY - $6.22 TO $6.44"
            //   New:  "ENTRY - $0.188 - $0.19"   (hyphen as range separator)
            entry: /ENTRY\s*[-–]\s*\$?\s*([0-9.]+)\s*\$?\s*(?:TO|[-–])\s*\$?\s*([0-9.]+)\s*\$?/i,

            // Direction — supports both keywords:
            //   Old:  "DIRECTION - SHORT"
            //   New:  "TYPE - SHORT"
            direction: /(?:DIRECTION|TYPE)\s*[-–]\s*(LONG|SHORT|BUY|SELL)/i,

            // e.g.  "TARGET - $6.20$ 6.12$ ..."  or  "TARGET - $0.186, $0.184 & $0.177+"
            // _extractNumbers() will strip $, commas, &, + automatically
            target:    /TARGET\s*[-–]\s*(.*)/i,

            // e.g.  "SL - $6.56"  or  "SL - 6.56$"  or  "SL - $0.199"
            sl:        /SL\s*[-–]\s*\$?\s*([0-9.]+)\s*\$?/i,

            // e.g.  "LEVERAGE - 10x"  or  "LEVERAGE - 20X"
            leverage:  /LEVERAGE\s*[-–]\s*([0-9]+)\s*[xX]/i,

            // e.g.  "Trader - ORANGE"  or  "Trader - Apple"
            trader:    /Trader\s*[-–]\s*(\w+)/i
        };

        // ── Format 2: Legacy #COIN/USDT header ──────────────────────────────────
        this.newPatterns = {
            signalHeader: /#([A-Z0-9]+)\/USDT\s*\(\s*(Long|Short)[^,]*,\s*x(\d+)\s*\)/i,
            entryPrice:   /Entry\s*-\s*([0-9.]+)/i,
            tpLevels:     /([0-9.]+)\s*\(\d+%\s*of\s*profit\)/gi,
            tpPrice:      /Price\s*-\s*([0-9.]+)/i,
            tpProfit:     /Profit\s*-\s*(\d+)%/i
        };

        // ── Format 3: Very old format ────────────────────────────────────────────
        this.oldPatterns = {
            coin:      /Coin pair:\s*([A-Z0-9]+)/i,
            direction: /Order:\s*(buy|sell)/i
        };

        // ── Format 4: VVIP "Pairs: TRX/USDT" ─────────────────────────────────────
        this.vvipPatterns = {
            header:    /Pairs:\s*([A-Z0-9]+(?:\/[A-Z0-9]+)?)/i,
            direction: /Trade\s*Type\s*=\s*(LONG|SHORT|BUY|SELL)/i,
            leverage:  /Leverage\s*[:-]+\s*([0-9]+)\s*[xX]/i,
            entry:     /Entry\s*=?\s*\[?\s*([0-9.]+)\s*(?:TO|[-–])\s*([0-9.]+)\s*\]?/i,
            sl:        /StopLoss\s*[:-]+\s*([0-9.]+)/i,
            target:    /Take\s*profit\s*=?\s*\[?(.*)/i
        };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Normalize text: strip known emojis and collapse non-ASCII to a space.
     */
    _normalizeText(text) {
        const replacements = {
            '📌': '', '⭕️': '', '📈': '', '📉': '', '✴️': '', '⚠️': '',
            '🟢': '', '🔴': '', '⭐': '', '🚀': '', '💠': '',
            '🇱🇰': '', '🔥': '', '🔔': '', '✅': '', '⏰': '', '⚠': '',
            '👉': '', '🎰': '', '🎯': '', '💰': '', '📊': '', '🛑': '',
            '⚡': '', '❌': ''
        };

        let normalized = text;
        for (const [emoji, replacement] of Object.entries(replacements)) {
            normalized = normalized.replace(new RegExp(emoji, 'g'), replacement);
        }

        // Collapse remaining non-ASCII (covers other emoji variants)
        normalized = normalized.replace(/[^\x00-\x7F]+/g, ' ');
        return normalized;
    }

    /**
     * Extract all numeric values from a string (e.g. a TARGET line).
     * Handles patterns like: "$6.20$ 6.12$ $5.90 5.871$"
     */
    _extractNumbers(str) {
        const nums = [];
        const regex = /\b([0-9]+(?:\.[0-9]+)?)\b/g;
        let m;
        while ((m = regex.exec(str)) !== null) {
            const val = parseFloat(m[1]);
            if (!isNaN(val)) nums.push(val);
        }
        return nums;
    }

    /**
     * Validate that the stop-loss price makes sense for the given direction.
     *   SHORT → SL must be ABOVE entry
     *   LONG  → SL must be BELOW entry
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

    // ─────────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Parse a Telegram message and return a structured signal object, or null.
     */
    parseMessage(text, timestamp = Date.now()) {
        try {
            const normalizedText = this._normalizeText(text);
            logger.info(`Parsing message (${text.length} chars): ${normalizedText.substring(0, 200)}...`);

            // ── Try Format 1: SCALP TRADE ────────────────────────────────────────
            const scalpResult = this._parseScalpFormat(normalizedText, text, timestamp);
            if (scalpResult) return scalpResult;

            // ── Try Format 2: #COIN/USDT header ─────────────────────────────────
            const legacyResult = this._parseLegacyFormat(normalizedText, text, timestamp);
            if (legacyResult) return legacyResult;

            // ── Try Format 4: VVIP "Pairs: TRX/USDT" ─────────────────────────────
            const vvipResult = this._parseVvipFormat(normalizedText, text, timestamp);
            if (vvipResult) return vvipResult;

            // ── Try Format 3: Very old ───────────────────────────────────────────
            const oldResult = this._parseOldFormat(normalizedText, text, timestamp);
            if (oldResult) return oldResult;

            logger.warn('Message does not match any known signal format');
            return null;

        } catch (error) {
            logger.error(`Parsing error: ${error.message}`, error);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Format parsers
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Parse Format 1 – SCALP TRADE signals.
     *
     * Example:
     *   ✅ SCALP TRADE - ENS
     *   👉 ENTRY - 6.22$ TO 6.44$
     *   👉 DIRECTION - SHORT
     *   👉 TARGET - $6.20$ 6.12$ 6.02$ $5.90 5.871$
     *   👉 SL - $6.56
     *   🎰 LEVERAGE - 10x
     *   Trader - ORANGE
     */
    _parseScalpFormat(normalizedText, rawText, timestamp) {
        const headerMatch = normalizedText.match(this.scalpPatterns.header);
        if (!headerMatch) return null;

        const symbolName = headerMatch[1].toUpperCase();
        const coin = symbolName.endsWith('USDT') ? symbolName : `${symbolName}USDT`;

        // ── Direction ────────────────────────────────────────────────────────────
        const directionMatch = normalizedText.match(this.scalpPatterns.direction);
        if (!directionMatch) {
            logger.warn(`SCALP format detected for ${coin} but no DIRECTION found`);
            return null;
        }
        const directionRaw = directionMatch[1].toUpperCase();
        const direction = (directionRaw === 'LONG' || directionRaw === 'BUY') ? 'LONG' : 'SHORT';

        // ── Entry prices (range) ─────────────────────────────────────────────────
        const entryMatch = normalizedText.match(this.scalpPatterns.entry);
        let entryPrices = [];
        if (entryMatch) {
            const low  = parseFloat(entryMatch[1]);
            const high = parseFloat(entryMatch[2]);
            if (!isNaN(low))  entryPrices.push(low);
            if (!isNaN(high) && high !== low) entryPrices.push(high);
        }

        if (entryPrices.length === 0) {
            logger.warn(`SCALP format detected for ${coin} but no ENTRY prices found`);
            return null;
        }

        // ── Targets ──────────────────────────────────────────────────────────────
        const targetMatch = normalizedText.match(this.scalpPatterns.target);
        let targets = [];
        if (targetMatch) {
            targets = this._extractNumbers(targetMatch[1]);
        }

        // ── Stop Loss ────────────────────────────────────────────────────────────
        const slMatch = normalizedText.match(this.scalpPatterns.sl);
        const stopLoss = slMatch ? parseFloat(slMatch[1]) : null;

        // Validate SL direction
        if (stopLoss !== null) {
            const entryRef = direction === 'LONG' ? Math.min(...entryPrices) : Math.max(...entryPrices);
            this._validateStopLossDirection(direction, entryRef, stopLoss);
        }

        // ── Leverage ─────────────────────────────────────────────────────────────
        const leverageMatch = normalizedText.match(this.scalpPatterns.leverage);
        const leverage = leverageMatch
            ? `${leverageMatch[1]}X`
            : `${process.env.DEFAULT_LEVERAGE || 20}X`;

        // ── Trader name (informational) ──────────────────────────────────────────
        const traderMatch = normalizedText.match(this.scalpPatterns.trader);
        const traderName = traderMatch ? traderMatch[1] : 'Unknown';

        logger.info(
            `[SCALP] ${coin} | ${direction} | Entry: [${entryPrices.join(', ')}] | ` +
            `Targets: [${targets.join(', ')}] | SL: ${stopLoss} | Leverage: ${leverage} | Trader: ${traderName}`
        );

        return {
            coin,
            direction,
            entryPrices,
            entryRange: {
                low:  Math.min(...entryPrices),
                high: Math.max(...entryPrices)
            },
            targets,
            stopLoss,
            leverage,
            traderName,
            signalType: 'SCALP',
            isTakeProfit: false,
            profit: 0.0,
            timestamp,
            message: rawText
        };
    }

    /**
     * Parse Format 2 – Legacy #COIN/USDT header signals.
     */
    _parseLegacyFormat(normalizedText, rawText, timestamp) {
        const signalHeaderMatch = normalizedText.match(this.newPatterns.signalHeader);
        if (!signalHeaderMatch) return null;

        const symbolName    = signalHeaderMatch[1].toUpperCase();
        const directionStr  = signalHeaderMatch[2].toUpperCase();
        const leverageValue = signalHeaderMatch[3];

        const coin      = `${symbolName}USDT`;
        const direction = directionStr === 'LONG' ? 'LONG' : 'SHORT';
        const leverage  = `${leverageValue}X`;

        // Entry price
        const entryMatch = normalizedText.match(this.newPatterns.entryPrice);
        const entryPrice = entryMatch ? parseFloat(entryMatch[1]) : null;

        if (entryPrice) {
            // TP levels
            const tpMatches = [...normalizedText.matchAll(this.newPatterns.tpLevels)];
            const targets   = tpMatches
                .map(m => parseFloat(m[1]))
                .filter(p => !isNaN(p));

            logger.info(
                `[LEGACY] ${coin} | ${direction} | Leverage: ${leverage} | ` +
                `Entry: ${entryPrice} | TPs: [${targets.join(', ')}]`
            );

            return {
                coin,
                direction,
                entryPrices: [entryPrice],
                targets,
                stopLoss: null,
                leverage,
                signalType: 'LEGACY',
                isTakeProfit: false,
                profit: 0.0,
                timestamp,
                message: rawText
            };
        }

        // Check if it is a TP update signal
        const tpPriceMatch  = normalizedText.match(this.newPatterns.tpPrice);
        const tpProfitMatch = normalizedText.match(this.newPatterns.tpProfit);

        if (tpPriceMatch && tpProfitMatch) {
            const tpPrice       = parseFloat(tpPriceMatch[1]);
            const profitPercent = parseFloat(tpProfitMatch[1]);

            logger.info(`[LEGACY TP] ${coin} | Price: ${tpPrice} | Profit: ${profitPercent}%`);

            return {
                coin,
                direction,
                entryPrices: [],
                targets: [tpPrice],
                stopLoss: null,
                leverage,
                signalType: 'LEGACY_TP',
                isTakeProfit: true,
                profit: profitPercent,
                timestamp,
                message: rawText
            };
        }

        logger.warn(`Legacy format detected for ${coin} but no entry/TP data found`);
        return null;
    }

    /**
     * Parse Format 3 – Very old "Coin pair / Order" format.
     */
    _parseOldFormat(normalizedText, rawText, timestamp) {
        const coinMatch      = normalizedText.match(this.oldPatterns.coin);
        const directionMatch = normalizedText.match(this.oldPatterns.direction);

        if (!coinMatch || !directionMatch) return null;

        let coinName = coinMatch[1].toUpperCase();
        coinName = coinName.replace('.P', '').replace('.PERP', '');
        const coin = coinName.endsWith('USDT') ? coinName : `${coinName}USDT`;

        const directionRaw = directionMatch[1].toUpperCase();
        const direction    = directionRaw === 'BUY' ? 'LONG' : 'SHORT';

        logger.info(`[OLD] ${coin} | ${direction}`);

        return {
            coin,
            direction,
            entryPrices: [],
            targets: [],
            stopLoss: null,
            leverage: `${process.env.DEFAULT_LEVERAGE || 20}X`,
            signalType: 'OLD',
            isTakeProfit: false,
            profit: 0.0,
            timestamp,
            message: rawText
        };
    }

    /**
     * Parse Format 4 – VVIP signals.
     *
     * Example:
     *   Pairs: TRX/USDT
     *   👉 Trade Type = LONG 🟢
     *   👉 Leverage :- 20x
     *   ⚡️ Entry = [ 0.3563 TO 0.3554 ]
     *   ❌ StopLoss :- 0.3439
     *   ✅ Take profit = [ 0.3618, 0.3667, 0.3691, 0.3743, 0.3809, 0.3869 ]
     *   Always Win VVIP
     */
    _parseVvipFormat(normalizedText, rawText, timestamp) {
        const headerMatch = normalizedText.match(this.vvipPatterns.header);
        if (!headerMatch) return null;

        let symbolName = headerMatch[1].toUpperCase().replace('/', '');
        const coin = symbolName.endsWith('USDT') ? symbolName : `${symbolName}USDT`;

        // ── Direction ────────────────────────────────────────────────────────────
        const directionMatch = normalizedText.match(this.vvipPatterns.direction);
        if (!directionMatch) {
            logger.warn(`VVIP format detected for ${coin} but no Trade Type found`);
            return null;
        }
        const directionRaw = directionMatch[1].toUpperCase();
        const direction = (directionRaw === 'LONG' || directionRaw === 'BUY') ? 'LONG' : 'SHORT';

        // ── Entry prices (range) ─────────────────────────────────────────────────
        const entryMatch = normalizedText.match(this.vvipPatterns.entry);
        let entryPrices = [];
        if (entryMatch) {
            const low  = parseFloat(entryMatch[1]);
            const high = parseFloat(entryMatch[2]);
            if (!isNaN(low))  entryPrices.push(low);
            if (!isNaN(high) && high !== low) entryPrices.push(high);
        }

        if (entryPrices.length === 0) {
            logger.warn(`VVIP format detected for ${coin} but no ENTRY prices found`);
            return null;
        }

        // ── Targets ──────────────────────────────────────────────────────────────
        const targetMatch = normalizedText.match(this.vvipPatterns.target);
        let targets = [];
        if (targetMatch) {
            targets = this._extractNumbers(targetMatch[1]);
        }

        // ── Stop Loss ────────────────────────────────────────────────────────────
        const slMatch = normalizedText.match(this.vvipPatterns.sl);
        const stopLoss = slMatch ? parseFloat(slMatch[1]) : null;

        // Validate SL direction
        if (stopLoss !== null) {
            const entryRef = direction === 'LONG' ? Math.min(...entryPrices) : Math.max(...entryPrices);
            this._validateStopLossDirection(direction, entryRef, stopLoss);
        }

        // ── Leverage ─────────────────────────────────────────────────────────────
        const leverageMatch = normalizedText.match(this.vvipPatterns.leverage);
        const leverage = leverageMatch
            ? `${leverageMatch[1]}X`
            : `${process.env.DEFAULT_LEVERAGE || 20}X`;

        logger.info(
            `[VVIP] ${coin} | ${direction} | Entry: [${entryPrices.join(', ')}] | ` +
            `Targets: [${targets.join(', ')}] | SL: ${stopLoss} | Leverage: ${leverage}`
        );

        return {
            coin,
            direction,
            entryPrices,
            entryRange: {
                low:  Math.min(...entryPrices),
                high: Math.max(...entryPrices)
            },
            targets,
            stopLoss,
            leverage,
            traderName: 'Always Win VVIP',
            signalType: 'VVIP',
            isTakeProfit: false,
            profit: 0.0,
            timestamp,
            message: rawText
        };
    }
}

export default TelegramSignalParser;
