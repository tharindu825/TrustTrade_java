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
     * Handle incoming signal
     */
    async handleSignal(signal) {
        try {
            logger.info(`Processing signal for ${signal.coin} (${signal.direction})`);

            // Validate symbol
            const isValid = await this.trader.validateSymbol(signal.coin);
            if (!isValid) {
                logger.warn(`Invalid symbol: ${signal.coin}`);
                return false;
            }

            // Check if we already have a position
            const hasPosition = await this.trader.hasSymbolPosition(signal.coin);
            if (hasPosition) {
                logger.info(`Already have position for ${signal.coin}. Skipping.`);
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
            const trendValidation = await this.directionValidator.validateSignalDirection(signal.coin, signal.direction);
            if (!trendValidation.valid) {
                logger.warn(`⚠️ Trend validation failed for ${signal.coin}: ${trendValidation.reason}`);
                // Alert is already sent by directionValidator.sendValidationAlert()
                return false;
            }

            // Check position limits
            const openPositionsCount = await this.trader.getOpenPositionsCount();
            if (openPositionsCount >= this.maxOpenPositions) {
                logger.info(`Max open positions reached (${openPositionsCount}/${this.maxOpenPositions}). Skipping.`);
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
            const { coin, direction, entryPrices, leverage } = signal;
            const entryPrice = entryPrices[0];

            // Parse leverage
            const leverageValue = parseInt(leverage.replace('X', ''));
            const finalLeverage = Math.min(leverageValue, this.trader.maxLeverage);

            // Set leverage and margin type
            await this.trader.setLeverage(coin, finalLeverage);
            await this.trader.setMarginType(coin, this.marginType);

            // Calculate position size
            const quantity = await this.trader.calculatePositionSize(coin, entryPrice, finalLeverage);
            if (quantity === 0) {
                logger.error(`Invalid quantity calculated for ${coin}`);
                return false;
            }

            // Calculate TP and SL prices (use signal targets if available)
            const { tp1Price, tp2Price, slPrice } = this.calculateTPSL(
                entryPrice,
                direction,
                finalLeverage,
                signal.targets
            );

            // Validate risk:reward ratio
            if (this.enableRiskRewardFilter) {
                const riskReward = this.calculateRiskReward(entryPrice, tp1Price, slPrice, direction);
                if (riskReward < this.minRiskReward) {
                    logger.warn(`Risk:Reward ratio too low: ${riskReward.toFixed(2)} (min: ${this.minRiskReward})`);
                    return false;
                }
                logger.info(`Risk:Reward ratio: ${riskReward.toFixed(2)}`);
            }

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
            logger.info(`Entry: ${entryPrice}, TP1: ${tp1Price}, TP2: ${tp2Price}, SL: ${slPrice}`);

            // Store signal for monitoring
            this.activeSignals.set(coin, {
                signal,
                entryOrderId: entryOrder.orderId,
                quantity,
                entryPrice,
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
     * Calculate TP and SL prices
     * Uses signal targets if provided, otherwise falls back to ROI-based calculation
     */
    calculateTPSL(entryPrice, direction, leverage, signalTargets = []) {
        let tp1Price, tp2Price, slPrice;

        // Use signal targets if available
        if (signalTargets && signalTargets.length >= 2) {
            tp1Price = signalTargets[0];
            tp2Price = signalTargets[signalTargets.length - 1]; // Use last TP as TP2

            // Calculate stop loss based on signal's risk profile
            // Use 1.5x the distance to the furthest TP as stop loss distance
            const tpDistance = Math.abs(entryPrice - tp2Price);
            const slDistance = tpDistance / 1.5; // Ensures min 1.5 R:R ratio

            if (direction === 'LONG') {
                slPrice = entryPrice - slDistance;
            } else {
                slPrice = entryPrice + slDistance;
            }

            logger.info(`Using signal TPs: TP1=${tp1Price}, TP2=${tp2Price}, calculated SL=${slPrice.toFixed(8)}`);
        } else {
            // Fallback to ROI-based calculation
            const tp1PriceChange = (entryPrice * this.tp1Roi / 100) / leverage;
            const tp2PriceChange = (entryPrice * this.tp2Roi / 100) / leverage;
            const slPriceChange = entryPrice * this.slPercentage;

            if (direction === 'LONG') {
                tp1Price = entryPrice + tp1PriceChange;
                tp2Price = entryPrice + tp2PriceChange;
                slPrice = entryPrice - slPriceChange;
            } else {
                tp1Price = entryPrice - tp1PriceChange;
                tp2Price = entryPrice - tp2PriceChange;
                slPrice = entryPrice + slPriceChange;
            }

            logger.info(`Using ROI-based TPs: TP1=${tp1Price}, TP2=${tp2Price}, SL=${slPrice}`);
        }

        return {
            tp1Price: parseFloat(tp1Price.toFixed(8)),
            tp2Price: parseFloat(tp2Price.toFixed(8)),
            slPrice: parseFloat(slPrice.toFixed(8))
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
        const { quantity, tp1Price, tp2Price, slPrice, exitSide } = signalData;

        // Track results for each order
        const results = {
            tp1: { success: false, orderId: null, error: null },
            tp2: { success: false, orderId: null, error: null },
            sl: { success: false, orderId: null, error: null }
        };

        try {
            // Format total quantity
            const totalQty = this.trader.formatQuantity(symbol, quantity);
            const tp1Raw = totalQty * 0.5;
            const tp1Quantity = this.trader.formatQuantity(symbol, tp1Raw);
            const tp2Raw = parseFloat((totalQty - tp1Quantity).toFixed(8));
            const tp2Quantity = this.trader.formatQuantity(symbol, tp2Raw);

            logger.info(`Placing protective orders for ${symbol}: Total=${totalQty}, TP1=${tp1Quantity}, TP2=${tp2Quantity}`);

            // Place TP1 (individual error handling)
            try {
                const tp1Order = await this.trader.placeTakeProfit(symbol, exitSide, tp1Quantity, tp1Price);
                results.tp1 = { success: true, orderId: tp1Order.orderId, error: null };
                signalData.tp1OrderId = tp1Order.orderId;
                signalData.tp1Quantity = tp1Quantity;  // Store for monitoring
                logger.info(`✅ TP1 placed: ${tp1Order.orderId}`);
            } catch (error) {
                results.tp1.error = error.message;
                logger.error(`❌ Failed to place TP1 for ${symbol}: ${error.message}`);
            }

            // Place TP2 (continue even if TP1 failed)
            if (tp2Quantity > 0) {
                try {
                    const tp2Order = await this.trader.placeTakeProfit(symbol, exitSide, tp2Quantity, tp2Price);
                    results.tp2 = { success: true, orderId: tp2Order.orderId, error: null };
                    signalData.tp2OrderId = tp2Order.orderId;
                    signalData.tp2Quantity = tp2Quantity;  // Store for monitoring
                    logger.info(`✅ TP2 placed: ${tp2Order.orderId}`);
                } catch (error) {
                    results.tp2.error = error.message;
                    logger.error(`❌ Failed to place TP2 for ${symbol}: ${error.message}`);
                }
            } else {
                logger.info(`Skipping TP2 (quantity 0)`);
                results.tp2 = { success: true, orderId: 'SKIPPED', error: null };
                signalData.tp2OrderId = 'SKIPPED';
                signalData.tp2Quantity = 0;
            }

            // Place SL (CRITICAL)
            try {
                const slOrder = await this.trader.placeStopLoss(symbol, exitSide, quantity, slPrice);
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
                await this.retrySLPlacement(symbol, signalData, results, quantity, exitSide, slPrice);
            }

            // Mark as protected if SL succeeded
            if (results.sl.success && this.positionTracker) {
                this.positionTracker.markProtected(symbol);
                if (!results.tp1.success || !results.tp2.success) {
                    const failed = [];
                    if (!results.tp1.success) failed.push('TP1');
                    if (!results.tp2.success) failed.push('TP2');
                    logger.warn(`⚠️ Position ${symbol} partially protected. Missing: ${failed.join(', ')}`);
                }
            }

            // Send alerts
            if (results.tp1.success && results.tp2.success && results.sl.success) {
                if (this.alerts) {
                    await this.alerts.sendAlert(
                        `🛡️ *Protective Orders Placed*\n\n` +
                        `Symbol: ${symbol}\n` +
                        `TP1: ${tp1Price}\n` +
                        `TP2: ${tp2Price}\n` +
                        `SL: ${slPrice}`,
                        'INFO'
                    );
                }
            } else {
                const failed = [];
                if (!results.tp1.success) failed.push('TP1');
                if (!results.tp2.success) failed.push('TP2');
                if (!results.sl.success) failed.push('SL');
                if (this.alerts) {
                    await this.alerts.sendAlert(
                        `⚠️ *Partial Protection*\n\n` +
                        `Symbol: ${symbol}\n` +
                        `Failed: ${failed.join(', ')}`,
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

        const intervalId = setInterval(async () => {
            try {
                // Fetch current position first
                const currentPosition = await this.trader.getPosition(symbol);

                // If position closed externally, stop monitoring
                const hasPosition = await this.trader.hasSymbolPosition(symbol);
                if (!hasPosition) {
                    logger.info(`Position ${symbol} no longer exists. Stopping monitor.`);

                    // Check if this was an SL hit (position closed but not TP filled)
                    const isSLHit = !signalData.tp2Filled;

                    if (this.tradeLogger) {
                        const closeData = await this.tradeLogger.logTradeClose(symbol, {
                            closePrice: currentPosition ? parseFloat(currentPosition.markPrice) : signalData.entryPrice,
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

                // Check TP1 Status
                if (!signalData.tp1Filled && signalData.tp1OrderId) {
                    const tp1Status = await this.trader.tradingClient.futuresGetOrder({
                        symbol,
                        orderId: signalData.tp1OrderId
                    });
                    if (tp1Status.status === 'FILLED') {
                        logger.info(`✅ TP1 Hit for ${symbol}`);
                        signalData.tp1Filled = true;

                        if (this.alerts) {
                            const profit = (parseFloat(tp1Status.avgPrice) - signalData.entryPrice) * signalData.tp1Quantity * (signalData.direction === 'SHORT' ? -1 : 1);
                            const profitPercent = ((parseFloat(tp1Status.avgPrice) - signalData.entryPrice) / signalData.entryPrice) * 100 * (signalData.direction === 'SHORT' ? -1 : 1);

                            await this.alerts.sendTPHitAlert(
                                symbol,
                                'TP1',
                                signalData.entryPrice,
                                parseFloat(tp1Status.avgPrice),
                                profit,
                                profitPercent,
                                50 // 50% position remaining
                            );
                        }

                        // Move SL to Breakeven
                        if (signalData.slOrderId) {
                            await this.moveStopLossToBreakeven(symbol, signalData);
                        }
                    }
                }

                // Check TP2 Status
                if (signalData.tp2OrderId && signalData.tp2OrderId !== 'SKIPPED') {
                    const tp2Status = await this.trader.tradingClient.futuresGetOrder({
                        symbol,
                        orderId: signalData.tp2OrderId
                    });
                    if (tp2Status.status === 'FILLED') {
                        logger.info(`✅ TP2 Hit for ${symbol} - Trade Complete!`);
                        signalData.tp2Filled = true;

                        if (this.alerts) {
                            const totalProfit = (parseFloat(tp2Status.avgPrice) - signalData.entryPrice) * signalData.totalQuantity * (signalData.direction === 'SHORT' ? -1 : 1);
                            const profitPercent = ((parseFloat(tp2Status.avgPrice) - signalData.entryPrice) / signalData.entryPrice) * 100 * (signalData.direction === 'SHORT' ? -1 : 1);

                            await this.alerts.sendTPHitAlert(
                                symbol,
                                'TP2',
                                signalData.entryPrice,
                                parseFloat(tp2Status.avgPrice),
                                totalProfit,
                                profitPercent,
                                null // Trade complete
                            );
                        }

                        // Trade likely done, but wait for position check loop to cleanup
                        clearInterval(intervalId);
                        this.activeSignals.delete(symbol);
                        return;
                    }
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
