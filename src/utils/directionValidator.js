import logger from './logger.js';

/**
 * Direction Validator - Validates signal direction against trend indicators
 */
class DirectionValidator {
    constructor(binanceClient, config) {
        this.client = binanceClient;
        this.enabled = config.ENABLE_DIRECTION_VALIDATION_FILTER === 'true';
        this.rsiPeriod = parseInt(config.DIRECTION_RSI_PERIOD || 14);
        this.emaPeriod = parseInt(config.DIRECTION_EMA_PERIOD || 20);
        this.macdFast = parseInt(config.DIRECTION_MACD_FAST || 12);
        this.macdSlow = parseInt(config.DIRECTION_MACD_SLOW || 26);
        this.macdSignal = parseInt(config.DIRECTION_MACD_SIGNAL || 9);
        this.klinesLimit = parseInt(config.DIRECTION_KLINES_LIMIT || 100);
        this.rsiBullishThreshold = parseFloat(config.DIRECTION_RSI_BULLISH_THRESHOLD || 50);
        this.rsiBearishThreshold = parseFloat(config.DIRECTION_RSI_BEARISH_THRESHOLD || 50);
        this.alertOnSkip = config.DIRECTION_ALERT_ON_SKIP === 'true';
        this.minIndicators = parseInt(config.DIRECTION_MIN_INDICATORS || 1); // Default: 1 of 3

        logger.info(`Direction Validator initialized: ${this.enabled ? 'Enabled' : 'Disabled'}, Min Indicators: ${this.minIndicators}/3`);
    }

    /**
     * Validate signal direction against trend indicators
     */
    async validateSignalDirection(symbol, signalDirection) {
        if (!this.enabled) {
            return { valid: true, reason: 'Direction validation disabled' };
        }

        try {
            // Fetch klines data
            const klines = await this.fetchKlines(symbol, '15m', this.klinesLimit);
            if (!klines || klines.length < this.klinesLimit) {
                logger.warn(`Insufficient klines data for ${symbol} (got ${klines?.length || 0}/${this.klinesLimit}), allowing trade`);
                return { valid: true, reason: 'Insufficient data' };
            }

            // Extract close prices
            const closes = klines.map(k => parseFloat(k.close || k[4])); // Handle both Object and Array format
            const currentPrice = closes[closes.length - 1];

            logger.debug(`${symbol}: Calculating indicators from ${closes.length} candles, current price: ${currentPrice}`);

            // Calculate indicators
            const rsi = this.calculateRSI(closes, this.rsiPeriod);
            const ema = this.calculateEMA(closes, this.emaPeriod);
            const macd = this.calculateMACD(closes, this.macdFast, this.macdSlow, this.macdSignal);

            // Determine trend
            const trend = this.determineTrend(rsi, ema, macd, currentPrice, signalDirection);

            logger.info(`Direction validation for ${symbol} (${signalDirection}): RSI=${rsi.toFixed(2)}, EMA=${ema.toFixed(4)}, MACD=${macd.histogram.toFixed(4)} (L:${macd.macdLine.toFixed(4)} S:${macd.signalLine.toFixed(4)}), Price=${currentPrice.toFixed(4)}, Valid=${trend.valid}`);

            return trend;

        } catch (error) {
            logger.error(`Error validating direction for ${symbol}: ${error.message}`, error);
            return { valid: true, reason: 'Validation error, allowing trade' };
        }
    }

    /**
     * Fetch klines (candlestick) data
     */
    async fetchKlines(symbol, interval = '15m', limit = 100) {
        try {
            const klines = await this.client.futuresCandles({
                symbol,
                interval,
                limit
            });

            if (!klines || klines.length === 0) {
                logger.warn(`No klines data returned for ${symbol}`);
                return null;
            }

            logger.debug(`Fetched ${klines.length} klines for ${symbol}`);
            return klines;
        } catch (error) {
            logger.error(`Error fetching klines for ${symbol}: ${error.message}`);
            return null;
        }
    }

    /**
     * Calculate RSI (Relative Strength Index)
     */
    calculateRSI(closes, period = 14) {
        if (closes.length < period + 1) {
            return 50; // Neutral if insufficient data
        }

        let gains = 0;
        let losses = 0;

        // Calculate initial average gain/loss
        for (let i = 1; i <= period; i++) {
            const change = closes[i] - closes[i - 1];
            if (change > 0) {
                gains += change;
            } else {
                losses += Math.abs(change);
            }
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        // Calculate RSI using smoothed averages
        for (let i = period + 1; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) {
            return 100;
        }

        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        return rsi;
    }

    /**
     * Calculate EMA (Exponential Moving Average)
     */
    /**
     * Calculate EMA Array (Returns array of EMA values matching input length)
     * For indices < period-1, values are null/undefined or incomplete.
     * Index period-1 is the first valid EMA (SMA of first 'period' values).
     */
    calculateEMAArray(closes, period = 20) {
        if (closes.length < period) return [];

        const multiplier = 2 / (period + 1);
        const emaArray = new Array(closes.length).fill(null);

        // Initial SMA
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += closes[i];
        }
        let ema = sum / period;
        emaArray[period - 1] = ema;

        // Calculate subsequent EMAs
        for (let i = period; i < closes.length; i++) {
            ema = (closes[i] - ema) * multiplier + ema;
            emaArray[i] = ema;
        }

        return emaArray;
    }

    /**
     * Calculate EMA (Exponential Moving Average) - Returns single latest value
     */
    calculateEMA(closes, period = 20) {
        const emaArray = this.calculateEMAArray(closes, period);
        return emaArray.length > 0 ? emaArray[emaArray.length - 1] : null;
    }

    /**
     * Calculate MACD (Moving Average Convergence Divergence)
     * Standard Formula:
     * - MACD Line = 12-Period EMA - 26-Period EMA
     * - Signal Line = 9-Period EMA of MACD Line
     * - Histogram = MACD Line - Signal Line
     */
    calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        // 1. Calculate Fast and Slow EMA Arrays
        const emaFastArray = this.calculateEMAArray(closes, fastPeriod);
        const emaSlowArray = this.calculateEMAArray(closes, slowPeriod);

        if (!emaFastArray.length || !emaSlowArray.length) {
            return { macdLine: 0, signalLine: 0, histogram: 0 };
        }

        // 2. Derive MACD Line Array
        const macdLineArray = [];
        // We need aligned data. The slow EMA starts later (at index slowPeriod-1).
        // Before that, we can't calculate MACD.
        for (let i = 0; i < closes.length; i++) {
            if (emaFastArray[i] !== null && emaSlowArray[i] !== null) {
                macdLineArray.push(emaFastArray[i] - emaSlowArray[i]);
            } else {
                macdLineArray.push(null); // Preserve index alignment
            }
        }

        // 3. Calculate Signal Line (EMA of MACD Line)
        // We need to filter out nulls to calculate EMA, but we need to be careful about alignment.
        // The standard way is to calculate EMA on the valid MACD series.
        const validMacdValues = macdLineArray.filter(val => val !== null);

        if (validMacdValues.length < signalPeriod) {
            // Not enough data for Signal Line
            const lastMacd = validMacdValues.length > 0 ? validMacdValues[validMacdValues.length - 1] : 0;
            return { macdLine: lastMacd, signalLine: 0, histogram: 0 };
        }

        const signalLineArray = this.calculateEMAArray(validMacdValues, signalPeriod);

        // 4. Get Final Values
        const currentMacdLine = validMacdValues[validMacdValues.length - 1];
        const currentSignalLine = signalLineArray[signalLineArray.length - 1];
        const currentHistogram = currentMacdLine - currentSignalLine;

        return {
            macdLine: currentMacdLine,
            signalLine: currentSignalLine,
            histogram: currentHistogram
        };
    }
    /**
     * Determine if signal direction aligns with trend
     */
    determineTrend(rsi, ema, macd, currentPrice, signalDirection) {
        const indicators = {
            rsi: { value: rsi, bullish: false, bearish: false },
            ema: { value: ema, bullish: false, bearish: false },
            macd: { value: macd.histogram, bullish: false, bearish: false }
        };

        // RSI analysis (use >= and <= to avoid neutral zone)
        indicators.rsi.bullish = rsi >= this.rsiBullishThreshold;
        indicators.rsi.bearish = rsi <= this.rsiBearishThreshold;

        // EMA analysis
        indicators.ema.bullish = currentPrice > ema;
        indicators.ema.bearish = currentPrice < ema;

        // MACD analysis
        indicators.macd.bullish = macd.histogram > 0;
        indicators.macd.bearish = macd.histogram < 0;

        // Count bullish and bearish signals
        const bullishCount = [
            indicators.rsi.bullish,
            indicators.ema.bullish,
            indicators.macd.bullish
        ].filter(Boolean).length;

        const bearishCount = [
            indicators.rsi.bearish,
            indicators.ema.bearish,
            indicators.macd.bearish
        ].filter(Boolean).length;

        // Log indicator states for debugging
        logger.debug(`${signalDirection} signal - RSI: ${rsi.toFixed(2)} (B: ${indicators.rsi.bullish}, Be: ${indicators.rsi.bearish}), EMA: ${ema.toFixed(4)} vs Price: ${currentPrice.toFixed(4)} (B: ${indicators.ema.bullish}, Be: ${indicators.ema.bearish}), MACD: ${macd.histogram.toFixed(4)} (L:${macd.macdLine.toFixed(4)} S:${macd.signalLine.toFixed(4)}) (B: ${indicators.macd.bullish}, Be: ${indicators.macd.bearish})`);

        // Validate signal direction
        let valid = false;
        let reason = '';


        if (signalDirection === 'LONG') {
            valid = bullishCount >= this.minIndicators; // Configurable threshold
            reason = valid
                ? `Bullish trend confirmed(${bullishCount} / 3 indicators, min: ${this.minIndicators})`
                : `Insufficient bullish indicators(${bullishCount} / 3, need: ${this.minIndicators})`;
        } else if (signalDirection === 'SHORT') {
            valid = bearishCount >= this.minIndicators; // Configurable threshold
            reason = valid
                ? `Bearish trend confirmed(${bearishCount} / 3 indicators, min: ${this.minIndicators})`
                : `Insufficient bearish indicators(${bearishCount} / 3, need: ${this.minIndicators})`;
        }

        return {
            valid,
            reason,
            indicators: {
                rsi: rsi.toFixed(2),
                ema: ema.toFixed(4),
                macd: macd.histogram.toFixed(4),
                currentPrice: currentPrice.toFixed(4)
            }
        };
    }
}

export default DirectionValidator;
