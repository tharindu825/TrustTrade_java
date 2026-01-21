import logger from '../utils/logger.js';

/**
 * Trading Strategy - Handles signal processing and trade execution logic
 */
class TradingStrategy {
    constructor(binanceTrader, config) {
        this.trader = binanceTrader;
        this.config = config;

        // Risk management
        this.minBalance = parseFloat(config.MIN_BALANCE || 1.0);
        this.maxOpenPositions = parseInt(config.MAX_OPEN_POSITIONS || 1);
        this.slPercentage = parseFloat(config.SL_PERCENTAGE || 0.07);
        this.tp1Roi = parseFloat(config.TP1_ROI || 0.5);
        this.tp2Roi = parseFloat(config.TP2_ROI || 2.0);
        this.minRiskReward = parseFloat(config.MIN_RISK_REWARD || 1.5);

        // Filters
        this.enableRiskRewardFilter = config.ENABLE_RISK_REWARD_FILTER === 'true';
        this.enableVolatilityFilter = config.ENABLE_VOLATILITY_FILTER === 'true';

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
            await this.trader.setMarginType(coin, 'ISOLATED');

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

                    // Send Alert
                    if (this.alerts) {
                        await this.alerts.sendTradeAlert(signalData.signal, 'ENTRY FILLED');
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
        try {
            const { quantity, tp1Price, tp2Price, slPrice, exitSide } = signalData;

            // Format total quantity first to ensure we work with valid numbers
            const totalQty = this.trader.formatQuantity(symbol, quantity);

            // Split quantity for TP1 and TP2 (50% each)
            // Calculate TP1 and format it
            const tp1Raw = totalQty * 0.5;
            const tp1Quantity = this.trader.formatQuantity(symbol, tp1Raw);

            // Calculate TP2 as remaining quantity to ensure sum matches total exactly
            // Using toFixed(8) to avoid floating point artifacts before formatting
            const tp2Raw = parseFloat((totalQty - tp1Quantity).toFixed(8));
            const tp2Quantity = this.trader.formatQuantity(symbol, tp2Raw);

            logger.info(`Quantity Split: Total=${totalQty} -> TP1=${tp1Quantity}, TP2=${tp2Quantity}`);

            // Place TP1 order
            const tp1Order = await this.trader.placeTakeProfit(
                symbol,
                exitSide,
                tp1Quantity,
                tp1Price
            );

            // Place TP2 order only if quantity > 0
            let tp2Order = null;
            if (tp2Quantity > 0) {
                tp2Order = await this.trader.placeTakeProfit(
                    symbol,
                    exitSide,
                    tp2Quantity,
                    tp2Price
                );
            } else {
                logger.info(`Skipping TP2 (quantity 0)`);
                tp2Order = { orderId: 'SKIPPED' };
            }

            // Place SL order
            const slOrder = await this.trader.placeStopLoss(
                symbol,
                exitSide,
                quantity,
                slPrice
            );

            logger.info(`✅ All protective orders placed successfully for ${symbol}`);
            logger.info(`TP1: ${tp1Order.orderId}, TP2: ${tp2Order.orderId}, SL: ${slOrder.orderId}`);

            // Send Alert
            if (this.alerts) {
                await this.alerts.sendAlert(
                    `🛡️ *Protective Orders Placed*\n\n` +
                    `Symbol: ${symbol}\n` +
                    `TP1: ${tp1Price}\n` +
                    `TP2: ${tp2Price}\n` +
                    `SL: ${slPrice}`,
                    'info'
                );
            }

            // Mark position as protected in tracker
            if (this.positionTracker) {
                this.positionTracker.markProtected(symbol);
            }

            // Update signal data
            signalData.tp1OrderId = tp1Order.orderId;
            signalData.tp2OrderId = tp2Order.orderId;
            signalData.slOrderId = slOrder.orderId;

        } catch (error) {
            logger.error(`Error placing protective orders for ${symbol}: ${error.message}`, error);
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
                // If position closed externally, stop monitoring
                const hasPosition = await this.trader.hasSymbolPosition(symbol);
                if (!hasPosition) {
                    logger.info(`Position ${symbol} no longer exists. Stopping monitor.`);

                    // Log trade close (SL hit or manual close)
                    if (this.tradeLogger) {
                        // Try to get last price from position history or use entry price as fallback
                        const positions = await this.trader.monitoringClient.futuresPositionRisk();
                        const closedPos = positions.find(p => p.symbol === symbol);
                        const closePrice = closedPos ? parseFloat(closedPos.markPrice) : signalData.entryPrice;

                        this.tradeLogger.logTradeClose(symbol, {
                            closePrice,
                            remark: signalData.tp1Filled ? 'Partial TP - Position Closed' : 'SL Hit or Manual Close'
                        });
                    }

                    clearInterval(intervalId);
                    this.activeSignals.delete(symbol);
                    return;
                }

                // Check TP1 Status
                if (!signalData.tp1Filled && signalData.tp1OrderId) {
                    const tp1Status = await this.trader.tradingClient.futuresOrder({ symbol, orderId: signalData.tp1OrderId });
                    if (tp1Status.status === 'FILLED') {
                        logger.info(`✅ TP1 Hit for ${symbol}`);
                        signalData.tp1Filled = true;

                        if (this.alerts) {
                            await this.alerts.sendAlert(`💰 *TP1 Hit for ${symbol}*\nPrice: ${tp1Status.avgPrice}`, 'SUCCESS');
                        }

                        // Move SL to Breakeven
                        if (signalData.slOrderId) {
                            await this.moveStopLossToBreakeven(symbol, signalData);
                        }
                    }
                }

                // Check TP2 Status
                if (signalData.tp2OrderId && signalData.tp2OrderId !== 'SKIPPED') {
                    const tp2Status = await this.trader.tradingClient.futuresOrder({ symbol, orderId: signalData.tp2OrderId });
                    if (tp2Status.status === 'FILLED') {
                        logger.info(`✅ TP2 Hit for ${symbol}`);

                        if (this.alerts) {
                            await this.alerts.sendAlert(`💰 *TP2 Hit for ${symbol}*\nPrice: ${tp2Status.avgPrice}\nTrade Complete!`, 'SUCCESS');
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
        try {
            logger.info(`Moving SL to breakeven for ${symbol}...`);

            // Cancel existing SL
            await this.trader.cancelOrder(symbol, signalData.slOrderId);

            // Place new SL at Entry Price
            // We need current position size? Or original - TP1? 
            // TP1 filled means size is half.
            // But safest is to get current position size.
            const position = await this.trader.getPosition(symbol);
            if (!position) return;

            const quantity = Math.abs(parseFloat(position.positionAmt));
            const entryPrice = signalData.entryPrice;
            // Add a small buffer for fees? Or raw entry? Usually raw entry.
            // Ensure entry price is valid for STOP_MARKET stopPrice
            const formattedStopPrice = this.trader.formatPrice(symbol, entryPrice);

            const newSlOrder = await this.trader.tradingClient.futuresOrder({
                symbol,
                side: signalData.exitSide,
                type: 'STOP_MARKET',
                stopPrice: formattedStopPrice,
                closePosition: true // Use closePosition=true if possible, simpler than managing Qty
            });

            signalData.slOrderId = newSlOrder.orderId;
            logger.info(`✅ SL moved to breakeven for ${symbol} at ${formattedStopPrice}`);

            if (this.alerts) {
                await this.alerts.sendAlert(`🛡️ *SL Moved to Breakeven*\nSymbol: ${symbol}\nNew SL: ${formattedStopPrice}`, 'INFO');
            }

        } catch (error) {
            logger.error(`Failed to move SL to breakeven for ${symbol}: ${error.message}`);
            if (this.alerts) {
                await this.alerts.sendAlert(`⚠️ Failed to move SL to breakeven for ${symbol}: ${error.message}`, 'ERROR');
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
