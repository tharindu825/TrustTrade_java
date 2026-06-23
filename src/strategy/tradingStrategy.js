import logger from '../utils/logger.js';
import DirectionValidator from '../utils/directionValidator.js';

/**
 * Trading Strategy - Handles signal processing and trade execution logic
 */
class TradingStrategy {
    constructor(binanceTrader, config) {
        this.trader = binanceTrader;
        this.config = config;

        // Risk management
        this.minBalance = parseFloat(config.MIN_BALANCE || 1.0);
        this.maxOpenPositions = parseInt(config.MAX_OPEN_POSITIONS || 3);
        this.riskPerTrade = parseFloat(config.RISK_PER_TRADE || 2.0);
        this.tpPercentage = parseFloat(config.TP_PERCENTAGE || 3.0);
        this.slPercentage = parseFloat(config.SL_PERCENTAGE || 1.5);

        // TP ROI levels (used when signal does not supply TP targets)
        this.tp1Roi = parseFloat(config.TP1_ROI || 0.4);  // e.g. 0.4 = 40% ROI at leverage
        this.tp2Roi = parseFloat(config.TP2_ROI || 1.0);  // e.g. 1.0 = 100% ROI at leverage

        // Leverage
        this.defaultLeverage = parseInt(config.DEFAULT_LEVERAGE || 10);
        this.maxLeverageCap  = parseInt(config.MAX_LEVERAGE || 15);

        // Signal SL/Leverage preference
        this.useSignalSL = config.USE_SIGNAL_SL !== 'false';  // default: true — use signal's SL
        this.useSignalLeverage = config.USE_SIGNAL_LEVERAGE === 'true';  // default: false — use env leverage

        // Margin type configuration
        this.marginType = (config.MARGIN_TYPE || 'CROSSED').toUpperCase();

        // Direction validation
        this.enableDirectionValidation = config.ENABLE_DIRECTION_VALIDATION === 'true';

        // Direction validator (advanced - trend-based validation)
        this.directionValidator = new DirectionValidator(binanceTrader.monitoringClient, config);

        // State
        this.activeSignals = new Map();
        this.positionTracker = null;
        this.alerts = null;
        this.tradeLogger = null;
    }

    /**
     * Set position tracker (called after initialization)
     */
    setPositionTracker(tracker) {
        this.positionTracker = tracker;
        logger.info('Position tracker linked to trading strategy');
    }

    /**
     * Set updates alerts instance
     */
    setAlerts(alerts) {
        this.alerts = alerts;
        // Also pass alerts to direction validator
        if (this.directionValidator) {
            this.directionValidator.alerts = alerts;
        }
        logger.info('Telegram alerts linked to trading strategy');
    }

    /**
     * Set trade logger instance
     */
    setTradeLogger(tradeLogger) {
        this.tradeLogger = tradeLogger;
        logger.info('Trade logger linked to trading strategy');
    }

    /**
     * Hot-reload configuration (called when settings are saved via GUI)
     */
    reloadConfig(config) {
        this.config = config;

        // Risk management
        this.minBalance = parseFloat(config.MIN_BALANCE || 1.0);
        this.maxOpenPositions = parseInt(config.MAX_OPEN_POSITIONS || 3);
        this.riskPerTrade = parseFloat(config.RISK_PER_TRADE || 2.0);
        this.tpPercentage = parseFloat(config.TP_PERCENTAGE || 3.0);
        this.slPercentage = parseFloat(config.SL_PERCENTAGE || 1.5);

        // TP ROI levels
        this.tp1Roi = parseFloat(config.TP1_ROI || 0.4);
        this.tp2Roi = parseFloat(config.TP2_ROI || 1.0);

        // Leverage
        this.defaultLeverage = parseInt(config.DEFAULT_LEVERAGE || 10);
        this.maxLeverageCap = parseInt(config.MAX_LEVERAGE || 15);

        // Signal SL/Leverage preference
        this.useSignalSL = config.USE_SIGNAL_SL !== 'false';
        this.useSignalLeverage = config.USE_SIGNAL_LEVERAGE === 'true';

        // Margin type
        this.marginType = (config.MARGIN_TYPE || 'CROSSED').toUpperCase();

        // Direction validation
        this.enableDirectionValidation = config.ENABLE_DIRECTION_VALIDATION === 'true';

        // Reload direction validator config
        if (this.directionValidator) {
            this.directionValidator.reloadConfig(config);
        }

        logger.info('🔄 Trading Strategy config reloaded from GUI settings');
    }

    /**
     * Handle incoming signal
     */
    async handleSignal(signal) {
        try {
            logger.info(`Processing signal for ${signal.coin} (${signal.direction || 'TP Update'})`);

            // Handle TP signals - cancel pending limit orders
            if (signal.isTakeProfit) {
                if (signal.message.includes('Closed due to opposite direction')) {
                    // Handled by handleOppositeDirection which we might call from elsewhere,
                    // but for safety let's return here as it's not a normal entry signal.
                    return await this.handleOppositeDirection(signal);
                }

                // If we have an active tracking signal (limit order placed)
                if (this.activeSignals.has(signal.coin)) {
                    const hasPosition = await this.trader.hasSymbolPosition(signal.coin);
                    // If no position, the limit order hasn't filled yet!
                    if (!hasPosition) {
                        const activeSignal = this.activeSignals.get(signal.coin);
                        logger.warn(`🚨 DANGER: Coin ${signal.coin} reached ${signal.profit}% profit before limit order filled! Cancelling limit entry to avoid late entry trap.`);

                        await this.trader.cancelOrder(signal.coin, activeSignal.entryOrderId);
                        this.activeSignals.delete(signal.coin);

                        if (this.alerts) {
                            await this.alerts.sendAlert(
                                `🚫 *Entry Order Cancelled*\n\n` +
                                `Symbol: ${signal.coin}\n` +
                                `Reason: Coin reached ${signal.profit}% profit in channel before our limit order could fill.\n` +
                                `Action: Cancelled entry to prevent late entry trap.`,
                                'WARNING'
                            );
                        }
                    } else {
                        logger.info(`Ignoring TP signal for ${signal.coin} (profit ${signal.profit}%). Bot already has position and uses own TP1/TP2 system.`);
                    }
                } else {
                    logger.info(`Ignoring TP signal for ${signal.coin} (profit ${signal.profit}%). No active limit tracking for this coin.`);
                }
                return true;
            }

            // Validate symbol
            const isValid = await this.trader.validateSymbol(signal.coin);
            if (!isValid) {
                logger.warn(`Invalid symbol: ${signal.coin}`);
                return false;
            }

            // Check if we already have a real position on this coin
            const hasPosition = await this.trader.hasSymbolPosition(signal.coin);
            if (hasPosition) {
                logger.info(`Already have position for ${signal.coin}. Skipping.`);
                return false;
            }

            // Check if there is already a PENDING limit entry for this coin
            if (this.activeSignals.has(signal.coin)) {
                logger.info(`Already have a pending limit order for ${signal.coin}. Skipping.`);
                return false;
            }

            // Direction validation (if enabled)
            if (this.enableDirectionValidation) {
                const currentDirection = await this.trader.getPositionDirection(signal.coin);
                if (currentDirection && currentDirection !== signal.direction) {
                    logger.warn(`⚠️ Direction validation failed for ${signal.coin}: Current=${currentDirection}, Signal=${signal.direction}. Skipping trade.`);
                    if (this.alerts) {
                        await this.alerts.sendAlert(
                            `⚠️ *Direction Validation Failed*\n\n` +
                            `Symbol: ${signal.coin}\n` +
                            `Current Position: ${currentDirection}\n` +
                            `New Signal: ${signal.direction}\n\n` +
                            `Trade rejected to prevent conflicting positions.`,
                            'WARNING'
                        );
                    }
                    return false;
                }
            }

            // Advanced direction validation (trend-based filter)
            const trendValidation = await this.directionValidator.validateSignalDirection(signal.coin, signal.direction, signal);
            if (!trendValidation.valid) {
                logger.warn(`⚠️ Trend validation failed for ${signal.coin}: ${trendValidation.reason}`);
                // Alert is already sent by directionValidator.sendValidationAlert()
                return false;
            }

            // Check position limits — count both real positions AND pending limit orders
            const openPositionsCount = await this.trader.getOpenPositionsCount();
            const pendingOrdersCount = this.activeSignals.size;
            const totalUsedSlots = openPositionsCount + pendingOrdersCount;
            if (totalUsedSlots >= this.maxOpenPositions) {
                logger.info(`Max open positions reached (real=${openPositionsCount}, pending=${pendingOrdersCount}, max=${this.maxOpenPositions}). Skipping.`);
                return false;
            }

            // Check balance
            const balance = await this.trader.getAccountBalance();
            if (balance < this.minBalance) {
                logger.warn(`Insufficient balance: ${balance} USDT (min: ${this.minBalance})`);
                return false;
            }

            // Execute trade based on signal type
            if (signal.entryPrices.length > 0) {
                // Limit order entry
                return await this.executeLimitEntry(signal);
            } else {
                // Market order entry (old format)
                return await this.executeMarketEntry(signal);
            }

        } catch (error) {
            logger.error(`Error handling signal for ${signal.coin}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * Execute limit order entry
     */
    async executeLimitEntry(signal) {
        try {
            const { coin, direction, entryPrices } = signal;

            // For SCALP signals with an entry range, choose the conservative limit price:
            //   LONG  → buy at the lower end of the range (wait for a dip)
            //   SHORT → sell at the higher end of the range (wait for a bounce)
            let entryPrice;
            if (entryPrices.length >= 2) {
                entryPrice = direction === 'LONG'
                    ? Math.min(...entryPrices)
                    : Math.max(...entryPrices);
                logger.info(`Entry range [${entryPrices.join(', ')}] → conservative limit price: ${entryPrice}`);
            } else {
                entryPrice = entryPrices[0];
            }

            // Determine leverage: use signal's leverage if USE_SIGNAL_LEVERAGE=true, else env
            let finalLeverage;
            if (this.useSignalLeverage && signal.leverage) {
                const signalLev = parseInt(signal.leverage);
                finalLeverage = Math.min(signalLev, this.maxLeverageCap);
                logger.info(`Using SIGNAL leverage: ${finalLeverage}x (signal=${signalLev}x, cap=${this.maxLeverageCap}x)`);
            } else {
                finalLeverage = Math.min(this.defaultLeverage, this.maxLeverageCap);
                logger.info(`Using ENV leverage: ${finalLeverage}x (DEFAULT_LEVERAGE=${this.defaultLeverage}, MAX_LEVERAGE=${this.maxLeverageCap})`);
            }

            // Set leverage and margin type
            await this.trader.setLeverage(coin, finalLeverage);
            await this.trader.setMarginType(coin, this.marginType);

            // Calculate position size
            const quantity = await this.trader.calculatePositionSize(coin, entryPrice, finalLeverage);
            if (quantity === 0) {
                logger.error(`Invalid quantity calculated for ${coin}`);
                return false;
            }

            // Calculate TP and SL prices
            // When USE_SIGNAL_SL=true (default), signal.stopLoss is used directly
            // When USE_SIGNAL_SL=false, SL is derived from TP distance or SL_PERCENTAGE
            const explicitSL = this.useSignalSL ? signal.stopLoss : null;
            if (this.useSignalSL && signal.stopLoss) {
                logger.info(`📍 Using SIGNAL StopLoss: ${signal.stopLoss} (USE_SIGNAL_SL=true)`);
            } else if (signal.stopLoss) {
                logger.info(`📍 Ignoring signal StopLoss ${signal.stopLoss}, using predefined SL (USE_SIGNAL_SL=false)`);
            }
            const { tpPrices, tp1Price, tp2Price, slPrice } = this.calculateTPSL(
                entryPrice,
                direction,
                finalLeverage,
                signal.targets,
                explicitSL
            );

            // R:R is now validated in the direction validator's slot system
            const riskReward = this.calculateRiskReward(entryPrice, tp1Price, slPrice, direction);
            logger.info(`Risk:Reward ratio: ${riskReward.toFixed(2)}`);

            // Determine order side
            const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
            const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';

            // Place limit entry order
            const entryOrder = await this.trader.placeLimitOrder(
                coin,
                entrySide,
                quantity,
                entryPrice.toFixed(8)
            );

            logger.info(`✅ Limit entry order placed for ${coin}`);
            logger.info(`Entry: ${entryPrice}, TPs: [${tpPrices.join(', ')}], SL: ${slPrice}`);

            // Store signal for monitoring
            this.activeSignals.set(coin, {
                signal,
                entryOrderId: entryOrder.orderId,
                quantity,
                entryPrice,
                tpPrices,
                tp1Price,
                tp2Price,
                slPrice,
                exitSide,
                leverage: finalLeverage
            });

            // Start monitoring this order
            this.monitorLimitOrder(coin);

            return true;

        } catch (error) {
            logger.error(`Error executing limit entry for ${signal.coin}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * Execute market order entry (old format)
     */
    async executeMarketEntry(signal) {
        logger.info(`Market order execution not yet implemented for ${signal.coin}`);
        return false;
    }

    /**
     * Calculate TP and SL prices.
     *
     * Priority order for SL:
     *   1. Explicit SL from signal (SCALP format provides this)
     *   2. Derived from TP2 distance (legacy fallback)
     *   3. SL_PERCENTAGE env fallback
     *
     * Priority order for TPs:
     *   1. Signal targets array (if provided)
     *   2. ROI-based calculation using TP1_ROI / TP2_ROI from env
     */
    calculateTPSL(entryPrice, direction, leverage, signalTargets = [], explicitSL = null) {
        let tpPrices = [];
        let slPrice;

        // ── Determine Stop Loss ──────────────────────────────────────────────────
        if (explicitSL !== null && !isNaN(explicitSL) && explicitSL > 0) {
            // Priority 1: explicit SL provided by signal (SCALP format)
            slPrice = explicitSL;
            logger.info(`Using explicit SL from signal: ${slPrice}`);
        }

        // ── Determine Take Profits ───────────────────────────────────────────────
        if (signalTargets && signalTargets.length >= 1) {
            tpPrices = [...signalTargets];

            // If we have only 1 target, derive a second target to satisfy any multi-TP assumptions
            if (tpPrices.length === 1) {
                const tp1Price = tpPrices[0];
                const tp1Distance = Math.abs(entryPrice - tp1Price);
                const tp2Price = direction === 'LONG'
                    ? entryPrice + tp1Distance * 2
                    : entryPrice - tp1Distance * 2;
                tpPrices.push(tp2Price);

                if (slPrice === undefined) {
                    slPrice = direction === 'LONG'
                        ? entryPrice - tp1Distance
                        : entryPrice + tp1Distance;
                }
                logger.info(`Single target – TP1=${tp1Price}, derived TP2=${tp2Price.toFixed(8)}, SL=${slPrice}`);
            } else {
                // If signal has multiple targets, and SL is not set, derive SL from the last target distance
                if (slPrice === undefined) {
                    const tpLastPrice = tpPrices[tpPrices.length - 1];
                    const tpDistance = Math.abs(entryPrice - tpLastPrice);
                    slPrice = direction === 'LONG'
                        ? entryPrice - tpDistance
                        : entryPrice + tpDistance;
                    logger.info(`Derived SL from last TP distance: ${slPrice.toFixed(8)}`);
                }
                logger.info(`Using signal TPs: count=${tpPrices.length}, targets=[${tpPrices.join(', ')}], SL=${slPrice}`);
            }
        } else {
            // Priority 3: ROI-based calculation using env TP1_ROI / TP2_ROI
            const tp1PriceChange = (entryPrice * this.tp1Roi) / leverage;
            const tp2PriceChange = (entryPrice * this.tp2Roi) / leverage;

            let tp1Price, tp2Price;
            if (direction === 'LONG') {
                tp1Price = entryPrice + tp1PriceChange;
                tp2Price = entryPrice + tp2PriceChange;
            } else {
                tp1Price = entryPrice - tp1PriceChange;
                tp2Price = entryPrice - tp2PriceChange;
            }
            tpPrices = [tp1Price, tp2Price];

            logger.info(`ROI-based TPs: TP1=${tp1Price.toFixed(8)} (ROI ${this.tp1Roi}%), TP2=${tp2Price.toFixed(8)} (ROI ${this.tp2Roi}%) at ${leverage}x`);

            if (slPrice === undefined) {
                // SL_PERCENTAGE fallback
                const slPriceChange = entryPrice * (this.slPercentage / 100);
                slPrice = direction === 'LONG'
                    ? entryPrice - slPriceChange
                    : entryPrice + slPriceChange;
                logger.info(`SL from env SL_PERCENTAGE (${this.slPercentage}%): ${slPrice.toFixed(8)}`);
            }
        }

        const tp1Price = tpPrices[0];
        const tp2Price = tpPrices[tpPrices.length - 1];

        return {
            tpPrices: tpPrices.map(tp => parseFloat(tp.toFixed(8))),
            tp1Price: parseFloat(tp1Price.toFixed(8)),
            tp2Price: parseFloat(tp2Price.toFixed(8)),
            slPrice:  parseFloat(slPrice.toFixed(8))
        };
    }

    /**
     * Calculate risk:reward ratio
     */
    calculateRiskReward(entryPrice, tpPrice, slPrice, direction) {
        let risk, reward;

        if (direction === 'LONG') {
            risk = entryPrice - slPrice;
            reward = tpPrice - entryPrice;
        } else {
            risk = slPrice - entryPrice;
            reward = entryPrice - tpPrice;
        }

        return reward / risk;
    }

    /**
     * Get symbol filters from cached exchangeInfo
     */
    getSymbolFilters(symbol) {
        if (!this.trader || !this.trader.exchangeInfo || !this.trader.exchangeInfo.symbols) {
            return { minQty: 0, minNotional: 5.0 };
        }
        const symInfo = this.trader.exchangeInfo.symbols.find(s => s.symbol === symbol);
        if (!symInfo) {
            return { minQty: 0, minNotional: 5.0 };
        }
        const lotSize = symInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotional = symInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL') || symInfo.filters.find(f => f.filterType === 'NOTIONAL');

        return {
            minQty: lotSize ? parseFloat(lotSize.minQty || 0) : 0,
            minNotional: minNotional ? parseFloat(minNotional.notional || minNotional.minNotional || 5.0) : 5.0
        };
    }

    /**
     * Monitor limit order for fills
     */
    async monitorLimitOrder(symbol) {
        const checkInterval = 10000; // Check every 10 seconds
        const maxWaitTime = 3600000; // 1 hour timeout

        const startTime = Date.now();

        const intervalId = setInterval(async () => {
            try {
                const signalData = this.activeSignals.get(symbol);
                if (!signalData) {
                    clearInterval(intervalId);
                    return;
                }

                // Check if order is filled
                const hasPosition = await this.trader.hasSymbolPosition(symbol);

                if (hasPosition) {
                    logger.info(`✅ Limit order filled for ${symbol}! Placing TP/SL orders...`);
                    clearInterval(intervalId);

                    // Send Entry Fill Alert
                    if (this.alerts) {
                        const positionValue = signalData.entryPrice * signalData.quantity;
                        await this.alerts.sendEntryFillAlert(
                            symbol,
                            signalData.signal.direction,
                            signalData.entryPrice,
                            signalData.quantity,
                            signalData.leverage,
                            positionValue
                        );
                    }

                    // Log trade open
                    if (this.tradeLogger) {
                        signalData.tradeId = this.tradeLogger.logTradeOpen({
                            symbol,
                            direction: signalData.signal.direction,
                            entryPrice: signalData.entryPrice,
                            quantity: signalData.quantity,
                            leverage: signalData.leverage,
                            tp1Price: signalData.tp1Price,
                            tp2Price: signalData.tp2Price,
                            slPrice: signalData.slPrice
                        });
                    }

                    // Track position
                    if (this.positionTracker) {
                        this.positionTracker.trackPosition(symbol, signalData);
                    }

                    // Place protective orders
                    await this.placeProtectiveOrders(symbol, signalData);

                    // Start monitoring this active trade for TP/SL hits
                    this.monitorActiveTrade(symbol, signalData);

                    return;
                }

                // Check timeout
                if (Date.now() - startTime > maxWaitTime) {
                    logger.warn(`Limit order timeout for ${symbol}. Canceling...`);
                    clearInterval(intervalId);

                    await this.trader.cancelOrder(symbol, signalData.entryOrderId);
                    this.activeSignals.delete(symbol);
                }

            } catch (error) {
                logger.error(`Error monitoring limit order for ${symbol}: ${error.message}`, error);
            }
        }, checkInterval);
    }

    /**
     * Place protective TP/SL orders after entry is filled
     */
    async placeProtectiveOrders(symbol, signalData) {
        const { quantity, slPrice, exitSide } = signalData;
        const tpPrices = signalData.tpPrices || [];

        // Track results
        const results = {
            tpPlaced: 0,
            tpFailed: 0,
            sl: { success: false, orderId: null, error: null }
        };

        try {
            // Format total quantity
            const totalQty = this.trader.formatQuantity(symbol, quantity);

            // Get symbol filters
            const filters = this.getSymbolFilters(symbol);
            const minNotional = filters.minNotional;
            const minQty = filters.minQty;
            logger.info(`Placing protective orders for ${symbol}: Total=${totalQty}, SL=${slPrice}`);
            logger.info(`Symbol ${symbol} filters: minQty=${minQty}, minNotional=${minNotional}`);

            const numTargets = tpPrices.length;
            if (numTargets === 0) {
                logger.error(`No TP targets found for ${symbol}!`);
                return;
            }

            const rawQtyPerTarget = totalQty / numTargets;
            let qtyPerTarget = this.trader.formatQuantity(symbol, rawQtyPerTarget);
            if (qtyPerTarget < minQty) {
                qtyPerTarget = minQty;
            }

            // Build proposed TPs
            const proposedTPs = [];
            let remainingQty = totalQty;

            for (let i = 0; i < numTargets; i++) {
                const price = tpPrices[i];
                let targetQty = (i === numTargets - 1) ? remainingQty : qtyPerTarget;
                targetQty = this.trader.formatQuantity(symbol, targetQty);

                if (targetQty <= 0) {
                    continue;
                }

                proposedTPs.push({
                    price,
                    quantity: targetQty
                });

                remainingQty -= targetQty;
                remainingQty = parseFloat(remainingQty.toFixed(8));
            }

            // Validate and merge undersized TPs
            const validTPs = [];
            for (let i = 0; i < proposedTPs.length; i++) {
                const tp = proposedTPs[i];
                const notional = tp.quantity * tp.price;

                if (tp.quantity < minQty || notional < minNotional) {
                    logger.info(`TP target ${tp.price} is undersized (Qty: ${tp.quantity}, Notional: ${notional.toFixed(2)} USDT). Merging...`);
                    
                    if (validTPs.length > 0) {
                        validTPs[validTPs.length - 1].quantity = this.trader.formatQuantity(
                            symbol,
                            validTPs[validTPs.length - 1].quantity + tp.quantity
                        );
                        logger.info(`Merged into previous TP at ${validTPs[validTPs.length - 1].price}, new quantity: ${validTPs[validTPs.length - 1].quantity}`);
                    } else {
                        if (i + 1 < proposedTPs.length) {
                            proposedTPs[i + 1].quantity = this.trader.formatQuantity(
                                symbol,
                                proposedTPs[i + 1].quantity + tp.quantity
                            );
                            logger.info(`Merged into next TP at ${proposedTPs[i + 1].price}, new quantity: ${proposedTPs[i + 1].quantity}`);
                        } else {
                            validTPs.push(tp);
                        }
                    }
                } else {
                    validTPs.push(tp);
                }
            }

            // Combine TPs with same price
            const uniqueTPs = [];
            for (const tp of validTPs) {
                const existing = uniqueTPs.find(u => Math.abs(u.price - tp.price) < 0.00000001);
                if (existing) {
                    existing.quantity = this.trader.formatQuantity(symbol, existing.quantity + tp.quantity);
                } else {
                    uniqueTPs.push(tp);
                }
            }

            // Format total allocated and adjust diff
            let totalAllocated = uniqueTPs.reduce((sum, tp) => sum + tp.quantity, 0);
            totalAllocated = this.trader.formatQuantity(symbol, totalAllocated);

            const diff = parseFloat((totalQty - totalAllocated).toFixed(8));
            if (diff !== 0 && uniqueTPs.length > 0) {
                logger.info(`Adjusting last TP quantity by ${diff} to match total position size`);
                uniqueTPs[uniqueTPs.length - 1].quantity = this.trader.formatQuantity(
                    symbol,
                    uniqueTPs[uniqueTPs.length - 1].quantity + diff
                );
            }

            // Clear old values and prepare new array
            signalData.tpOrders = [];

            // Place all valid TPs
            for (let i = 0; i < uniqueTPs.length; i++) {
                const tp = uniqueTPs[i];
                try {
                    logger.info(`Placing TP${i+1}/${uniqueTPs.length}: Price=${tp.price}, Qty=${tp.quantity}`);
                    const tpOrder = await this.trader.placeTakeProfit(symbol, exitSide, tp.quantity, tp.price);
                    
                    signalData.tpOrders.push({
                        price: tp.price,
                        quantity: tp.quantity,
                        orderId: tpOrder.orderId,
                        filled: false
                    });
                    results.tpPlaced++;
                    logger.info(`✅ TP${i+1} placed: ${tpOrder.orderId}`);
                } catch (error) {
                    results.tpFailed++;
                    logger.error(`❌ Failed to place TP${i+1} at ${tp.price}: ${error.message}`);
                }
            }

            // Map legacy TP variables for backward compatibility and position tracking
            if (signalData.tpOrders.length > 0) {
                signalData.tp1OrderId = signalData.tpOrders[0].orderId;
                signalData.tp1Quantity = signalData.tpOrders[0].quantity;
                signalData.tp1Price = signalData.tpOrders[0].price;

                if (signalData.tpOrders.length > 1) {
                    const lastTp = signalData.tpOrders[signalData.tpOrders.length - 1];
                    signalData.tp2OrderId = lastTp.orderId;
                    signalData.tp2Quantity = lastTp.quantity;
                    signalData.tp2Price = lastTp.price;
                } else {
                    signalData.tp2OrderId = 'SKIPPED';
                    signalData.tp2Quantity = 0;
                    signalData.tp2Price = signalData.tp1Price;
                }
            }

            // Place SL (CRITICAL)
            try {
                const slOrder = await this.trader.placeStopLoss(symbol, exitSide, totalQty, slPrice);
                results.sl = { success: true, orderId: slOrder.orderId, error: null };
                signalData.slOrderId = slOrder.orderId;
                logger.info(`✅ SL placed: ${slOrder.orderId}`);
            } catch (error) {
                results.sl.error = error.message;
                logger.error(`❌ CRITICAL: Failed to place SL for ${symbol}: ${error.message}`);
            }

            // Immediate SL retry if failed
            if (!results.sl.success) {
                logger.warn(`🔄 Attempting immediate SL retry for ${symbol}...`);
                await this.retrySLPlacement(symbol, signalData, results, totalQty, exitSide, slPrice);
            }

            // Mark as protected if SL succeeded
            if (results.sl.success && this.positionTracker) {
                // Update tracked position data to include placed order IDs and array
                const tracked = this.positionTracker.trackedPositions.get(symbol);
                if (tracked) {
                    tracked.tpOrders = signalData.tpOrders;
                    tracked.slOrderId = signalData.slOrderId;
                    tracked.tp1OrderId = signalData.tp1OrderId;
                    tracked.tp2OrderId = signalData.tp2OrderId;
                    tracked.tp1Quantity = signalData.tp1Quantity;
                    tracked.tp2Quantity = signalData.tp2Quantity;
                }
                this.positionTracker.markProtected(symbol);
                if (results.tpFailed > 0 || uniqueTPs.length === 0) {
                    logger.warn(`⚠️ Position ${symbol} partially protected. ${results.tpFailed} TPs failed to place.`);
                }
            }

            // Send alerts
            if (results.sl.success && results.tpFailed === 0) {
                if (this.alerts) {
                    const tpDetails = signalData.tpOrders.map((tp, idx) => `TP${idx+1}: ${tp.price} (${tp.quantity})`).join('\n');
                    await this.alerts.sendAlert(
                        `🛡️ *Protective Orders Placed*\n\n` +
                        `Symbol: ${symbol}\n` +
                        `${tpDetails}\n` +
                        `SL: ${slPrice}`,
                        'INFO'
                    );
                }
            } else {
                if (this.alerts) {
                    await this.alerts.sendAlert(
                        `⚠️ *Partial Protection*\n\n` +
                        `Symbol: ${symbol}\n` +
                        `Failed Take Profit orders: ${results.tpFailed}\n` +
                        `Stop Loss Status: ${results.sl.success ? 'PLACED' : 'FAILED'}`,
                        'WARNING'
                    );
                }
            }

        } catch (error) {
            logger.error(`Error in placeProtectiveOrders for ${symbol}: ${error.message}`, error);
        }
    }

    async retrySLPlacement(symbol, signalData, results, quantity, exitSide, slPrice, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            const delay = 1000 * Math.pow(2, i);
            logger.info(`Waiting ${delay}ms before SL retry ${i + 1}/${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, delay));

            try {
                const slOrder = await this.trader.placeStopLoss(symbol, exitSide, quantity, slPrice);
                results.sl = { success: true, orderId: slOrder.orderId, error: null };
                signalData.slOrderId = slOrder.orderId;
                logger.info(`✅ SL placed on retry ${i + 1}: ${slOrder.orderId}`);
                if (this.alerts) {
                    await this.alerts.sendAlert(
                        `✅ *SL Placed on Retry*\n\nSymbol: ${symbol}\nRetry: ${i + 1}/${maxRetries}`,
                        'SUCCESS'
                    );
                }
                return;
            } catch (error) {
                results.sl.error = error.message;
                logger.error(`❌ SL retry ${i + 1} failed: ${error.message}`);
            }
        }

        logger.error(`🚨 CRITICAL: All ${maxRetries} SL retries failed for ${symbol}`);
        if (this.alerts) {
            await this.alerts.sendAlert(
                `🚨 *CRITICAL: SL Failed*\n\nSymbol: ${symbol}\nAll retries failed!\nPosition UNPROTECTED!`,
                'CRITICAL'
            );
        }
    }

    /**
     * Poll active trade to check for TP/SL fills
     */
    monitorActiveTrade(symbol, signalData) {
        const checkInterval = 10000;
        signalData.tp1Filled = false;
        signalData.tp2Filled = false; // complete indicator

        const intervalId = setInterval(async () => {
            try {
                // Fetch current position first
                const currentPosition = await this.trader.getPosition(symbol);

                // If position closed externally, stop monitoring
                const hasPosition = await this.trader.hasSymbolPosition(symbol);
                if (!hasPosition) {
                    logger.info(`Position ${symbol} no longer exists. Stopping monitor.`);

                    // Check if this was an SL hit (position closed but not all TPs filled)
                    const allTPsFilled = (signalData.tpOrders || []).every(t => t.filled);
                    const isSLHit = !allTPsFilled;

                    // Determine actual close price
                    // When SL hits, position is already gone so currentPosition is null
                    // Fetch the actual fill price from Binance trade history
                    let closePrice = signalData.entryPrice; // Absolute last resort fallback
                    if (currentPosition && parseFloat(currentPosition.positionAmt) !== 0) {
                        closePrice = parseFloat(currentPosition.markPrice);
                    } else {
                        // Position is gone - fetch actual close price from Binance
                        const entryTime = new Date(signalData.signal?.entryTime || signalData.entryTime || Date.now() - 86400000).getTime();
                        const actualClosePrice = await this.trader.fetchLastTradePrice(symbol, entryTime);
                        if (actualClosePrice !== null) {
                            closePrice = actualClosePrice;
                            logger.info(`Using actual close price from Binance for ${symbol}: ${closePrice}`);
                        } else {
                            // Fallback to SL price if we know SL was hit
                            closePrice = signalData.tp1Filled ? signalData.entryPrice : signalData.slPrice;
                            logger.warn(`Could not fetch actual close price for ${symbol}, using ${signalData.tp1Filled ? 'entry' : 'SL'} price: ${closePrice}`);
                        }
                    }

                    if (this.tradeLogger) {
                        const closeData = await this.tradeLogger.logTradeClose(symbol, {
                            closePrice: closePrice,
                            remark: signalData.tp1Filled ? 'Partial TP - Position Closed' : 'SL Hit or Manual Close'
                        });

                        // Send SL hit alert if applicable
                        if (isSLHit && this.alerts && closeData) {
                            const entryTime = new Date(signalData.entryTime);
                            const closeTime = new Date();
                            const durationMs = closeTime - entryTime;
                            const durationMin = Math.floor(durationMs / 60000);
                            const duration = durationMin < 60
                                ? `${durationMin} minutes`
                                : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`;

                            await this.alerts.sendSLHitAlert(
                                symbol,
                                signalData.entryPrice,
                                closeData.closePrice || signalData.entryPrice,
                                closeData.pnl || 0,
                                closeData.pnlPercent || 0,
                                closeData.roiPercent || 0,
                                duration
                            );
                        } else if (!isSLHit && this.alerts && closeData) {
                            // Position closed after TP1 (manual close or other reason)
                            const isProfitable = closeData.pnl > 0;
                            const emoji = isProfitable ? '✅' : '⚠️';
                            const message =
                                `${emoji} *Position Closed: ${symbol}*\n\n` +
                                `Entry: $${signalData.entryPrice}\n` +
                                `Close: $${closeData.closePrice.toFixed(4)}\n` +
                                `PNL: $${closeData.pnl.toFixed(2)} (${closeData.pnlPercent.toFixed(2)}%)\n` +
                                `ROI: ${closeData.roiPercent.toFixed(2)}%\n` +
                                `Reason: ${closeData.remark}`;
                            await this.alerts.sendAlert(message, isProfitable ? 'SUCCESS' : 'WARNING');
                        }
                    }

                    clearInterval(intervalId);
                    this.activeSignals.delete(symbol);
                    return;
                }

                // Check all TP orders status
                const tpOrders = signalData.tpOrders || [];
                const totalQty = this.trader.formatQuantity(symbol, signalData.quantity);
                let allFilled = true;
                let firstJustFilled = false;

                for (let i = 0; i < tpOrders.length; i++) {
                    const tp = tpOrders[i];

                    if (tp.filled) {
                        continue;
                    }

                    allFilled = false;

                    if (tp.orderId) {
                        try {
                            const orderStatus = await this.trader.tradingClient.futuresGetOrder({
                                symbol,
                                orderId: tp.orderId
                            });

                            if (orderStatus.status === 'FILLED') {
                                logger.info(`✅ TP${i+1} Hit at ${tp.price} for ${symbol}`);
                                tp.filled = true;

                                // Calculate profit metrics
                                const avgPrice = parseFloat(orderStatus.avgPrice);
                                const directionMultiplier = signalData.direction === 'SHORT' ? -1 : 1;
                                const profit = (avgPrice - signalData.entryPrice) * tp.quantity * directionMultiplier;
                                const profitPercent = ((avgPrice - signalData.entryPrice) / signalData.entryPrice) * 100 * directionMultiplier;

                                // Calculate remaining percentage
                                const filledQty = tpOrders.filter(t => t.filled).reduce((sum, t) => sum + t.quantity, 0);
                                const remainingQty = Math.max(0, totalQty - filledQty);
                                const remainingPercent = Math.round((remainingQty / totalQty) * 100);

                                if (this.alerts) {
                                    await this.alerts.sendTPHitAlert(
                                        symbol,
                                        `TP${i+1}`,
                                        signalData.entryPrice,
                                        avgPrice,
                                        profit,
                                        profitPercent,
                                        remainingPercent > 0 ? remainingPercent : null
                                    );
                                }

                                // Check if this is the first TP to fill
                                if (!signalData.tp1Filled) {
                                    firstJustFilled = true;
                                }
                            }
                        } catch (err) {
                            if (err.code !== -2013) {
                                logger.error(`Error checking TP${i+1} status for ${symbol}: ${err.message}`);
                            }
                        }
                    }
                }

                if (firstJustFilled) {
                    signalData.tp1Filled = true;
                    // Move SL to Breakeven
                    if (signalData.slOrderId) {
                        await this.moveStopLossToBreakeven(symbol, signalData);
                    }
                }

                if (allFilled && tpOrders.length > 0) {
                    logger.info(`✅ All TPs Hit for ${symbol} - Trade Complete!`);
                    signalData.tp2Filled = true;

                    clearInterval(intervalId);
                    this.activeSignals.delete(symbol);
                    return;
                }

                // Check SL Status (if position still exists but we are here, SL might not be filled completely? Or SL filled means position gone)
                // If hasPosition is true, SL is not fully filled. 
                // But if SL is partially filled or if market moved close to SL?
                // Actually if SL fills, hasPosition becomes false (detected at top of loop).
                // So explicit SL check is less critical unless we want to know WHY it closed.

            } catch (error) {
                // Ignore error if order not found (might be cancelled/filled long ago)
                if (error.code !== -2013) {
                    logger.error(`Error monitoring active trade ${symbol}: ${error.message}`);
                }
            }
        }, checkInterval);
    }

    /**
     * Move Stop Loss to Entry Price (Breakeven)
     */
    async moveStopLossToBreakeven(symbol, signalData) {
        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                logger.info(`Moving SL to breakeven for ${symbol}... (Attempt ${attempt}/${maxRetries})`);

                // Cancel existing SL with error handling
                try {
                    await this.trader.cancelOrder(symbol, signalData.slOrderId);
                    logger.info(`Cancelled old SL order ${signalData.slOrderId} for ${symbol}`);
                } catch (cancelError) {
                    // If order already filled/cancelled, log but continue
                    if (cancelError.code === -2011) {
                        logger.warn(`Old SL order ${signalData.slOrderId} already inactive, proceeding...`);
                    } else {
                        throw cancelError; // Re-throw if it's a different error
                    }
                }

                // Get current position size and format values
                const position = await this.trader.getPosition(symbol);
                if (!position) {
                    logger.warn(`No position found for ${symbol}, cannot move SL to breakeven`);
                    return;
                }

                const quantity = Math.abs(parseFloat(position.positionAmt));
                const entryPrice = signalData.entryPrice;
                const formattedStopPrice = this.trader.formatPrice(symbol, entryPrice);

                // Place new SL at Entry Price using Algo Order API
                const newSlOrder = await this.trader.placeStopLoss(
                    symbol,
                    signalData.exitSide,
                    quantity,
                    entryPrice
                );

                signalData.slOrderId = newSlOrder.orderId;
                logger.info(`✅ SL moved to breakeven for ${symbol} at ${formattedStopPrice} (Order ID: ${newSlOrder.orderId})`);

                if (this.alerts) {
                    const message =
                        `🛡️ *SL Moved to Breakeven*\\n\\n` +
                        `Symbol: ${symbol}\\n` +
                        `Entry Price: $${signalData.entryPrice}\\n` +
                        `New SL: $${formattedStopPrice}\\n` +
                        `Status: TP1 filled, remaining 50% position protected`;
                    await this.alerts.sendAlert(message, 'SUCCESS');
                }

                // Success - exit retry loop
                return;

            } catch (error) {
                lastError = error;
                const errorMsg = error.message || 'Unknown error';
                logger.error(`Failed to move SL to breakeven for ${symbol} (Attempt ${attempt}/${maxRetries}): ${errorMsg}`);

                // If not the last attempt, wait before retrying
                if (attempt < maxRetries) {
                    const delay = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
                    logger.info(`Waiting ${delay}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    // All retries failed - send critical alert
                    logger.error(`🚨 CRITICAL: All ${maxRetries} attempts to move SL to breakeven failed for ${symbol}`);
                    if (this.alerts) {
                        await this.alerts.sendAlert(
                            `🚨 *CRITICAL: SL Move Failed*\\n\\n` +
                            `Symbol: ${symbol}\\n` +
                            `Error: ${errorMsg}\\n\\n` +
                            `All ${maxRetries} retry attempts failed!\\n` +
                            `⚠️ Position still protected by original SL at $${signalData.slPrice}\\n\\n` +
                            `Manual intervention may be required.`,
                            'CRITICAL'
                        );
                    }
                }
            }
        }
    }

    /**
     * Handle opposite direction signal (close existing position)
     */
    async handleOppositeDirection(signal) {
        try {
            logger.info(`Handling opposite direction signal for ${signal.coin}`);

            // Cancel all orders for this symbol
            await this.trader.cancelAllOrders(signal.coin);

            // Remove from active signals
            this.activeSignals.delete(signal.coin);

            logger.info(`Canceled all orders for ${signal.coin} due to opposite direction signal`);
            return true;

        } catch (error) {
            logger.error(`Error handling opposite direction for ${signal.coin}: ${error.message}`, error);
            return false;
        }
    }
}

export default TradingStrategy;
