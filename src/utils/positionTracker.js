import logger from './logger.js';

/**
 * Position Tracker - Monitors open positions and ensures they have protective orders
 */
class PositionTracker {
    constructor(trader, alerts) {
        this.trader = trader;
        this.alerts = alerts;
        this.trackedPositions = new Map();
        this.monitoringInterval = null;
        this.checkIntervalMs = 30000; // Check every 30 seconds
        this.maxRetries = 3;
    }

    /**
     * Start monitoring positions
     */
    startMonitoring() {
        logger.info('🔍 Starting position tracker...');

        // Initial check
        this.checkPositions();

        // Set up periodic monitoring
        this.monitoringInterval = setInterval(() => {
            this.checkPositions();
        }, this.checkIntervalMs);

        logger.info(`Position tracker started (checking every ${this.checkIntervalMs / 1000}s)`);
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
            logger.info('Position tracker stopped');
        }
    }

    /**
     * Track a new position
     */
    trackPosition(symbol, positionData) {
        this.trackedPositions.set(symbol, {
            ...positionData,
            trackedAt: Date.now(),
            hasTPSL: false,
            retryCount: 0,
            lastRetryAt: null
        });

        logger.info(`📍 Now tracking position: ${symbol}`);
    }

    /**
     * Mark position as having TP/SL orders
     */
    markProtected(symbol) {
        const position = this.trackedPositions.get(symbol);
        if (position) {
            position.hasTPSL = true;
            logger.info(`✅ Position ${symbol} marked as protected`);
        }
    }

    /**
     * Check all positions for missing TP/SL
     */
    async checkPositions() {
        try {
            const positions = await this.trader.monitoringClient.futuresPositionRisk();
            const openPositions = positions.filter(pos => parseFloat(pos.positionAmt) !== 0);

            logger.debug(`Checking ${openPositions.length} open positions...`);

            for (const pos of openPositions) {
                const symbol = pos.symbol;
                const tracked = this.trackedPositions.get(symbol);

                if (!tracked) {
                    // Position exists but not tracked - might be manual trade
                    logger.warn(`⚠️ Untracked position found: ${symbol}`);
                    continue;
                }

                // Check if position has TP/SL orders
                if (!tracked.hasTPSL) {
                    await this.handleUnprotectedPosition(symbol, tracked, pos);
                }
            }

            // Clean up closed positions
            for (const [symbol, tracked] of this.trackedPositions.entries()) {
                const stillOpen = openPositions.find(p => p.symbol === symbol);
                if (!stillOpen) {
                    logger.info(`Position ${symbol} closed, removing from tracker`);
                    this.trackedPositions.delete(symbol);
                }
            }

        } catch (error) {
            // Handle specific network errors
            if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' || error.message.includes('fetch failed')) {
                logger.warn(`Network error checking positions: ${error.message} (${error.code || 'UNKNOWN'})`);
            } else if (error.message.includes('recvWindow')) {
                logger.warn(`Timestamp error checking positions: ${error.message}`);
            } else {
                // For other errors, log full details but ensure it is not empty
                const errorDetails = error.stack || error.message || JSON.stringify(error);
                logger.error(`Error checking positions: ${error.message}`, { error: errorDetails });
            }
        }
    }

    /**
     * Handle position without TP/SL orders
     */
    async handleUnprotectedPosition(symbol, tracked, currentPosition) {
        const timeSinceTracked = Date.now() - tracked.trackedAt;
        const timeSinceLastRetry = tracked.lastRetryAt ? Date.now() - tracked.lastRetryAt : Infinity;

        // Give it 20 seconds before first retry (reduced from 60s for faster response)
        if (timeSinceTracked < 20000) {
            return;
        }

        // Check if we should retry
        if (tracked.retryCount >= this.maxRetries) {
            logger.error(`❌ Max retries reached for ${symbol} - POSITION AT RISK!`);

            // Send alert
            if (this.alerts) {
                await this.alerts.sendAlert(
                    `⚠️ *CRITICAL: Unprotected Position*\n\n` +
                    `Symbol: ${symbol}\n` +
                    `Position: ${currentPosition.positionAmt}\n` +
                    `Entry: ${currentPosition.entryPrice}\n` +
                    `Mark Price: ${currentPosition.markPrice}\n` +
                    `PNL: ${currentPosition.unrealizedProfit} USDT\n\n` +
                    `Failed to place TP/SL orders after ${this.maxRetries} attempts.\n` +
                    `Consider manually closing this position!`,
                    'ERROR'
                );
            }
            return;
        }

        // Wait at least 30 seconds between retries
        if (timeSinceLastRetry < 30000) {
            return;
        }

        // Retry placing protective orders
        logger.warn(`⚠️ Retrying protective orders for ${symbol} (attempt ${tracked.retryCount + 1}/${this.maxRetries})`);
        tracked.retryCount++;
        tracked.lastRetryAt = Date.now();

        try {
            await this.retryProtectiveOrders(symbol, tracked, currentPosition);
        } catch (error) {
            logger.error(`Failed to retry protective orders for ${symbol}: ${error.message}`);
        }
    }

    /**
     * Retry placing protective orders
     */
    async retryProtectiveOrders(symbol, tracked, currentPosition) {
        const { slPrice, exitSide, slOrderId } = tracked;
        const quantity = Math.abs(parseFloat(currentPosition.positionAmt));

        // Use new tpOrders if available, otherwise fall back to legacy TP1/TP2 splitting
        const tpOrders = tracked.tpOrders || [
            { price: tracked.tp1Price, quantity: this.trader.formatQuantity(symbol, quantity * 0.5), orderId: tracked.tp1OrderId },
            { price: tracked.tp2Price, quantity: this.trader.formatQuantity(symbol, quantity - this.trader.formatQuantity(symbol, quantity * 0.5)), orderId: tracked.tp2OrderId }
        ].filter(tp => tp.price && tp.quantity > 0);

        logger.info(`Retrying protective orders for ${symbol}:`);
        logger.info(`  Quantity: ${quantity}`);
        logger.info(`  SL: ${slPrice}`);

        // Check existing open orders to avoid duplicates
        const openOrders = await this.trader.getOpenOrders(symbol);
        const slExists = openOrders.some(o => o.orderId === slOrderId && o.status === 'NEW');

        logger.info(`  Existing orders - SL: ${slExists}`);

        const placedOrders = [];

        for (let i = 0; i < tpOrders.length; i++) {
            const tp = tpOrders[i];
            const tpExists = openOrders.some(o => o.orderId === tp.orderId && o.status === 'NEW');
            logger.info(`  TP${i+1} (${tp.price}): exists = ${tpExists}`);

            if (!tpExists) {
                logger.info(`  Placing TP${i+1} (missing)...`);
                try {
                    const tpOrder = await this.trader.placeTakeProfit(symbol, exitSide, tp.quantity, tp.price);
                    tp.orderId = tpOrder.orderId;
                    placedOrders.push(`TP${i+1}`);
                } catch (error) {
                    logger.error(`  Failed to place TP${i+1} at ${tp.price}: ${error.message}`);
                }
            } else {
                logger.info(`  TP${i+1} already exists, skipping`);
            }
        }

        // Place SL only if it doesn't exist
        if (!slExists) {
            logger.info(`  Placing SL (missing)...`);
            try {
                const slOrder = await this.trader.placeStopLoss(symbol, exitSide, quantity, slPrice);
                tracked.slOrderId = slOrder.orderId;
                placedOrders.push('SL');
            } catch (error) {
                logger.error(`  Failed to place SL: ${error.message}`);
            }
        } else {
            logger.info(`  SL already exists, skipping`);
        }

        // Update the tracked tpOrders if we mutated them
        if (!tracked.tpOrders && tracked.tp1Price) {
            tracked.tpOrders = tpOrders;
        }

        // Mark as protected
        this.markProtected(symbol);

        logger.info(`✅ Successfully verified/placed protective orders for ${symbol}`);

        // Send success alert
        if (this.alerts) {
            const message = placedOrders.length > 0
                ? `✅ *Protective Orders Placed*\n\n` +
                  `Symbol: ${symbol}\n` +
                  `Placed: ${placedOrders.join(', ')}`
                : `✅ *Protective Orders Verified*\n\n` +
                  `Symbol: ${symbol}\n` +
                  `All TP/SL orders already exist`;

            await this.alerts.sendAlert(message, 'SUCCESS');
        }
    }

    /**
     * Emergency close all positions
     */
    async emergencyCloseAll() {
        logger.warn('🚨 EMERGENCY CLOSE ALL POSITIONS INITIATED');

        try {
            const positions = await this.trader.monitoringClient.futuresPositionRisk();
            const openPositions = positions.filter(pos => parseFloat(pos.positionAmt) !== 0);

            if (openPositions.length === 0) {
                logger.info('No open positions to close');
                return { success: true, closed: 0 };
            }

            const results = [];
            for (const pos of openPositions) {
                try {
                    await this.emergencyClosePosition(pos.symbol);
                    results.push({ symbol: pos.symbol, success: true });
                } catch (error) {
                    logger.error(`Failed to close ${pos.symbol}: ${error.message}`);
                    results.push({ symbol: pos.symbol, success: false, error: error.message });
                }
            }

            const successCount = results.filter(r => r.success).length;
            logger.info(`Emergency close complete: ${successCount}/${openPositions.length} positions closed`);

            // Send alert
            if (this.alerts) {
                await this.alerts.sendAlert(
                    `🚨 *Emergency Close Executed*\n\n` +
                    `Closed: ${successCount}/${openPositions.length} positions`,
                    'WARNING'
                );
            }

            return { success: true, closed: successCount, total: openPositions.length, results };

        } catch (error) {
            logger.error(`Emergency close all failed: ${error.message}`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Emergency close single position
     */
    async emergencyClosePosition(symbol) {
        logger.warn(`🚨 Emergency closing position: ${symbol}`);

        // Cancel all orders for this symbol
        await this.trader.cancelAllOrders(symbol);

        // Get current position
        const positions = await this.trader.monitoringClient.futuresPositionRisk();
        const position = positions.find(p => p.symbol === symbol);

        if (!position || parseFloat(position.positionAmt) === 0) {
            logger.info(`No position to close for ${symbol}`);
            return;
        }

        const quantity = Math.abs(parseFloat(position.positionAmt));
        const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';

        // Place market order to close
        await this.trader.tradingClient.futuresOrder({
            symbol,
            side,
            type: 'MARKET',
            quantity: quantity.toString(),
            reduceOnly: true
        });

        logger.info(`✅ Emergency closed ${symbol}: ${side} ${quantity}`);

        // Remove from tracking
        this.trackedPositions.delete(symbol);
    }

    /**
     * Get unprotected positions
     */
    getUnprotectedPositions() {
        const unprotected = [];
        for (const [symbol, tracked] of this.trackedPositions.entries()) {
            if (!tracked.hasTPSL) {
                unprotected.push({
                    symbol,
                    trackedAt: tracked.trackedAt,
                    retryCount: tracked.retryCount,
                    timeSinceTracked: Date.now() - tracked.trackedAt
                });
            }
        }
        return unprotected;
    }
}

export default PositionTracker;
