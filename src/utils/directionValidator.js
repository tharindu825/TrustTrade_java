import logger from './logger.js';

/**
 * Direction Validator - 3-Slot Strictness Mode Filter System
 * 
 * Presets:
 *   LESS_STRICT (1/3):  Direction Validation + Risk:Reward + EMA
 *   MODERATE    (2/3):  Direction Validation + ADX + Risk:Reward
 *   VERY_STRICT (3/3):  Direction Validation + ADX + Volume Confirmation
 */

// Strictness preset definitions
const STRICTNESS_PRESETS = {
    LESS_STRICT: {
        slots: ['DIRECTION_VALIDATION', 'RISK_REWARD', 'EMA'],
        minRequired: 1,
        label: 'Less Strict (1 of 3)',
        description: 'Direction Validation + Risk:Reward + EMA — lets ~60-70% of signals through'
    },
    MODERATE: {
        slots: ['DIRECTION_VALIDATION', 'ADX', 'RISK_REWARD'],
        minRequired: 2,
        label: 'Moderate (2 of 3)',
        description: 'Direction Validation + ADX + Risk:Reward — best balance of win-rate vs volume'
    },
    VERY_STRICT: {
        slots: ['DIRECTION_VALIDATION', 'ADX', 'VOLUME'],
        minRequired: 3,
        label: 'Very Strict (3 of 3)',
        description: 'Direction Validation + ADX + Volume — only high-conviction setups'
    }
};

class DirectionValidator {
    constructor(binanceClient, config, alerts = null) {
        this.client = binanceClient;
        this.config = config;
        this.alerts = alerts;
        this.enabled = config.ENABLE_DIRECTION_VALIDATION_FILTER === 'true';

        // Strictness mode
        this.strictnessMode = (config.STRICTNESS_MODE || 'MODERATE').toUpperCase();
        this.preset = STRICTNESS_PRESETS[this.strictnessMode] || STRICTNESS_PRESETS.MODERATE;

        // Direction Validation sub-indicators (RSI, EMA, MACD)
        this.rsiPeriod = parseInt(config.DIRECTION_RSI_PERIOD || 14);
        this.emaPeriod = parseInt(config.DIRECTION_EMA_PERIOD || 20);
        this.macdFast = parseInt(config.DIRECTION_MACD_FAST || 12);
        this.macdSlow = parseInt(config.DIRECTION_MACD_SLOW || 26);
        this.macdSignal = parseInt(config.DIRECTION_MACD_SIGNAL || 9);
        this.klinesLimit = parseInt(config.DIRECTION_KLINES_LIMIT || 100);
        this.rsiBullishThreshold = parseFloat(config.DIRECTION_RSI_BULLISH_THRESHOLD || 50);
        this.rsiBearishThreshold = parseFloat(config.DIRECTION_RSI_BEARISH_THRESHOLD || 50);
        this.alertOnSkip = config.DIRECTION_ALERT_ON_SKIP === 'true';

        // ADX Filter config
        this.adxPeriod = parseInt(config.ADX_PERIOD || 14);
        this.minAdx = parseFloat(config.MIN_ADX || 22);

        // Volume Confirmation config
        this.volumePeriod = parseInt(config.VOLUME_PERIOD || 20);
        this.minVolumeMultiplier = parseFloat(config.MIN_VOLUME_MULTIPLIER || 0.8);

        // Risk:Reward config
        this.minRiskReward = parseFloat(config.MIN_RISK_REWARD || 1.5);
        this.slPercentage = parseFloat(config.SL_PERCENTAGE || 0.015);

        logger.info(`Direction Validator initialized: ${this.enabled ? 'Enabled' : 'Disabled'}, Mode: ${this.preset.label}, Slots: [${this.preset.slots.join(', ')}]`);
    }

    /**
     * Validate signal direction using the slot-based strictness system
     * @param {string} symbol - Trading pair symbol
     * @param {string} signalDirection - 'LONG' or 'SHORT'
     * @param {object} signal - Full signal object (for R:R calculation)
     */
    async validateSignalDirection(symbol, signalDirection, signal = null) {
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

            // Extract market data
            const closes = klines.map(k => parseFloat(k.close || k[4]));
            const highs = klines.map(k => parseFloat(k.high || k[2]));
            const lows = klines.map(k => parseFloat(k.low || k[3]));
            const volumes = klines.map(k => parseFloat(k.volume || k[5]));
            const currentPrice = closes[closes.length - 1];
            const currentVolume = volumes[volumes.length - 1];

            // Calculate all indicators
            const rsi = this.calculateRSI(closes, this.rsiPeriod);
            const ema = this.calculateEMA(closes, this.emaPeriod);
            const macd = this.calculateMACD(closes, this.macdFast, this.macdSlow, this.macdSignal);
            const adx = this.calculateADX(highs, lows, closes, this.adxPeriod);
            const avgVolume = this.calculateAverageVolume(volumes, this.volumePeriod);
            const volumeRatio = currentVolume / avgVolume;

            // Evaluate each slot
            const slotResults = {};
            for (const slot of this.preset.slots) {
                slotResults[slot] = this.evaluateSlot(slot, {
                    rsi, ema, macd, currentPrice, adx,
                    volumeRatio, signalDirection, signal
                });
            }

            // Count passes
            const passCount = Object.values(slotResults).filter(r => r.passed).length;
            const valid = passCount >= this.preset.minRequired;

            // Build reason string
            const slotSummaries = Object.entries(slotResults)
                .map(([name, r]) => `${r.passed ? '✅' : '❌'} ${this.getSlotLabel(name)}: ${r.detail}`)
                .join(' | ');

            const reason = valid
                ? `Passed (${passCount}/${this.preset.slots.length}, need ${this.preset.minRequired}) — ${slotSummaries}`
                : `Failed (${passCount}/${this.preset.slots.length}, need ${this.preset.minRequired}) — ${slotSummaries}`;

            // Log
            logger.info(`Direction validation for ${symbol} (${signalDirection}): RSI=${rsi.toFixed(2)}, EMA=${ema.toFixed(4)}, MACD=${macd.histogram.toFixed(4)}, ADX=${adx.toFixed(2)}, Vol=${volumeRatio.toFixed(2)}x, Valid=${valid}`);
            logger.info(`Slot results: ${slotSummaries}`);

            // Build indicator info for alerts
            const indicators = {
                rsi: rsi.toFixed(2),
                ema: ema.toFixed(4),
                macd: macd.histogram.toFixed(4),
                currentPrice: currentPrice.toFixed(4),
                adx: adx.toFixed(2),
                volumeRatio: volumeRatio.toFixed(2)
            };

            // Send validation alert
            if (this.alerts) {
                await this.alerts.sendValidationAlert(
                    symbol,
                    signalDirection,
                    valid,
                    reason,
                    indicators
                );
            }

            return { valid, reason, indicators, slotResults };

        } catch (error) {
            logger.error(`Error validating direction for ${symbol}: ${error.message}`, error);
            return { valid: true, reason: 'Validation error, allowing trade' };
        }
    }

    /**
     * Evaluate a single filter slot
     */
    evaluateSlot(slotName, data) {
        switch (slotName) {
            case 'DIRECTION_VALIDATION':
                return this.evaluateDirectionValidation(data);
            case 'EMA':
                return this.evaluateEMA(data);
            case 'ADX':
                return this.evaluateADX(data);
            case 'VOLUME':
                return this.evaluateVolume(data);
            case 'RISK_REWARD':
                return this.evaluateRiskReward(data);
            default:
                return { passed: true, detail: 'Unknown filter' };
        }
    }

    /**
     * Slot: Direction Validation (RSI + EMA + MACD — needs 2/3 to pass)
     */
    evaluateDirectionValidation(data) {
        const { rsi, ema, macd, currentPrice, signalDirection } = data;
        let bullish = 0, bearish = 0;

        // RSI
        if (rsi >= this.rsiBullishThreshold) bullish++;
        if (rsi <= this.rsiBearishThreshold) bearish++;

        // EMA
        if (currentPrice > ema) bullish++;
        if (currentPrice < ema) bearish++;

        // MACD
        if (macd.histogram > 0) bullish++;
        if (macd.histogram < 0) bearish++;

        const count = signalDirection === 'LONG' ? bullish : bearish;
        const passed = count >= 2; // Need at least 2 of 3 for direction confirmation

        return {
            passed,
            detail: `${count}/3 ${signalDirection === 'LONG' ? 'bullish' : 'bearish'}`
        };
    }

    /**
     * Slot: EMA standalone (price above/below EMA)
     */
    evaluateEMA(data) {
        const { ema, currentPrice, signalDirection } = data;
        const passed = signalDirection === 'LONG'
            ? currentPrice > ema
            : currentPrice < ema;

        return {
            passed,
            detail: `Price ${currentPrice.toFixed(4)} ${passed ? (signalDirection === 'LONG' ? '>' : '<') : (signalDirection === 'LONG' ? '<' : '>')} EMA ${ema.toFixed(4)}`
        };
    }

    /**
     * Slot: ADX Filter (trend strength)
     */
    evaluateADX(data) {
        const { adx } = data;
        const passed = adx >= this.minAdx;
        return {
            passed,
            detail: `ADX ${adx.toFixed(1)} ${passed ? '>=' : '<'} ${this.minAdx}`
        };
    }

    /**
     * Slot: Volume Confirmation
     */
    evaluateVolume(data) {
        const { volumeRatio } = data;
        const passed = volumeRatio >= this.minVolumeMultiplier;
        return {
            passed,
            detail: `Vol ${volumeRatio.toFixed(2)}x ${passed ? '>=' : '<'} ${this.minVolumeMultiplier}x`
        };
    }

    /**
     * Slot: Risk:Reward ratio
     */
    evaluateRiskReward(data) {
        const { signal, signalDirection } = data;

        // Need signal data to calculate R:R
        if (!signal || !signal.entryPrices || signal.entryPrices.length === 0 || !signal.targets || signal.targets.length < 2) {
            return { passed: true, detail: 'No R:R data (allowed)' };
        }

        const entryPrice = signal.entryPrices[0];
        const tp1Price = signal.targets[0];
        const tp2Price = signal.targets[signal.targets.length - 1];

        // Calculate SL same way as tradingStrategy.calculateTPSL
        const tpDistance = Math.abs(entryPrice - tp2Price);
        const slDistance = tpDistance / 1.0;
        const slPrice = signalDirection === 'LONG'
            ? entryPrice - slDistance
            : entryPrice + slDistance;

        // Calculate R:R using TP1
        let risk, reward;
        if (signalDirection === 'LONG') {
            risk = entryPrice - slPrice;
            reward = tp1Price - entryPrice;
        } else {
            risk = slPrice - entryPrice;
            reward = entryPrice - tp1Price;
        }

        const rr = risk > 0 ? reward / risk : 0;
        const passed = rr >= this.minRiskReward;
        return {
            passed,
            detail: `R:R ${rr.toFixed(2)} ${passed ? '>=' : '<'} ${this.minRiskReward}`
        };
    }

    /**
     * Get human-readable label for a slot
     */
    getSlotLabel(slotName) {
        const labels = {
            'DIRECTION_VALIDATION': 'Trend',
            'EMA': 'EMA',
            'ADX': 'ADX',
            'VOLUME': 'Volume',
            'RISK_REWARD': 'R:R'
        };
        return labels[slotName] || slotName;
    }

    // =============== Indicator Calculation Methods ===============

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
        for (let i = 0; i < closes.length; i++) {
            if (emaFastArray[i] !== null && emaSlowArray[i] !== null) {
                macdLineArray.push(emaFastArray[i] - emaSlowArray[i]);
            } else {
                macdLineArray.push(null);
            }
        }

        // 3. Calculate Signal Line (EMA of MACD Line)
        const validMacdValues = macdLineArray.filter(val => val !== null);

        if (validMacdValues.length < signalPeriod) {
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
     * Calculate ADX (Average Directional Index) - Measures trend strength
     */
    calculateADX(highs, lows, closes, period = 14) {
        if (highs.length < period + 1) {
            return 25; // Default neutral value
        }

        const trueRanges = [];
        const plusDMs = [];
        const minusDMs = [];

        // Calculate True Range, +DM, -DM
        for (let i = 1; i < highs.length; i++) {
            const high = highs[i];
            const low = lows[i];
            const prevHigh = highs[i - 1];
            const prevLow = lows[i - 1];
            const prevClose = closes[i - 1];

            // True Range
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trueRanges.push(tr);

            // Directional Movement
            const upMove = high - prevHigh;
            const downMove = prevLow - low;

            const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
            const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

            plusDMs.push(plusDM);
            minusDMs.push(minusDM);
        }

        // Calculate smoothed averages
        let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let plusDI = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let minusDI = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < trueRanges.length; i++) {
            atr = (atr * (period - 1) + trueRanges[i]) / period;
            plusDI = (plusDI * (period - 1) + plusDMs[i]) / period;
            minusDI = (minusDI * (period - 1) + minusDMs[i]) / period;
        }

        // Calculate DI+ and DI-
        const plusDIPercent = (plusDI / atr) * 100;
        const minusDIPercent = (minusDI / atr) * 100;

        // Calculate DX and ADX
        const dx = Math.abs(plusDIPercent - minusDIPercent) / (plusDIPercent + minusDIPercent) * 100;

        return dx; // Simplified ADX (using DX as approximation)
    }

    /**
     * Calculate average volume over period
     */
    calculateAverageVolume(volumes, period = 20) {
        if (volumes.length < period) {
            return volumes.reduce((a, b) => a + b, 0) / volumes.length;
        }

        const recentVolumes = volumes.slice(-period);
        return recentVolumes.reduce((a, b) => a + b, 0) / period;
    }
}

export { STRICTNESS_PRESETS };
export default DirectionValidator;
