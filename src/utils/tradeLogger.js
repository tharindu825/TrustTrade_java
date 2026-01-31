import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Trade Logger - Persists trade history to JSON file
 */
class TradeLogger {
    constructor() {
        this.tradesFile = path.join(process.cwd(), 'data', 'trades.json');
        this.trades = [];
        this.trader = null; // Will be set via setTrader()
        this.ensureDataDirectory();
        this.loadTrades();
    }

    /**
     * Set trader instance (for fetching realized PNL)
     */
    setTrader(trader) {
        this.trader = trader;
        logger.info('Trader instance linked to trade logger');
    }

    /**
     * Ensure data directory exists
     */
    ensureDataDirectory() {
        const dataDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            logger.info('Created data directory for trade logs');
        }
    }

    /**
     * Load trades from file
     */
    loadTrades() {
        try {
            if (fs.existsSync(this.tradesFile)) {
                const data = fs.readFileSync(this.tradesFile, 'utf8');
                const parsed = JSON.parse(data);
                this.trades = parsed.trades || [];
                logger.info(`Loaded ${this.trades.length} trades from history`);
            } else {
                this.trades = [];
                this.saveTrades();
                logger.info('Initialized new trade history file');
            }
        } catch (error) {
            logger.error(`Error loading trades: ${error.message}`);
            this.trades = [];
        }
    }

    /**
     * Save trades to file
     */
    saveTrades() {
        try {
            const data = JSON.stringify({ trades: this.trades }, null, 2);
            fs.writeFileSync(this.tradesFile, data, 'utf8');
        } catch (error) {
            logger.error(`Error saving trades: ${error.message}`);
        }
    }

    /**
     * Generate unique trade ID
     */
    generateTradeId() {
        return `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Log trade opening
     */
    logTradeOpen(tradeData) {
        const trade = {
            id: this.generateTradeId(),
            symbol: tradeData.symbol,
            direction: tradeData.direction,
            entryPrice: tradeData.entryPrice,
            entryTime: new Date().toISOString(),
            quantity: tradeData.quantity,
            leverage: tradeData.leverage,
            tp1Price: tradeData.tp1Price,
            tp2Price: tradeData.tp2Price,
            slPrice: tradeData.slPrice,
            closePrice: null,
            closeTime: null,
            pnl: null,
            pnlPercent: null,
            status: 'OPEN',
            remarks: []
        };

        this.trades.push(trade);
        this.saveTrades();

        logger.info(`Trade logged: ${trade.id} - ${trade.symbol} ${trade.direction} @ ${trade.entryPrice}`);

        return trade.id;
    }

    /**
     * Add remark to trade
     */
    addRemark(symbol, remark) {
        const trade = this.trades.find(t => t.symbol === symbol && t.status === 'OPEN');
        if (trade) {
            trade.remarks.push({
                text: remark,
                timestamp: new Date().toISOString()
            });
            this.saveTrades();
            logger.info(`Added remark to ${symbol}: ${remark}`);
        }
    }

    /**
     * Log trade close with actual Binance PNL
     */
    async logTradeClose(symbol, closeData) {
        const trade = this.trades.find(t => t.symbol === symbol && t.status === 'OPEN');
        if (!trade) {
            logger.warn(`No open trade found for ${symbol} to close`);
            return;
        }

        trade.closePrice = closeData.closePrice;
        trade.closeTime = new Date().toISOString();
        trade.status = 'CLOSED';

        // Try to fetch actual realized PNL from Binance
        const entryTime = new Date(trade.entryTime).getTime();
        const closeTime = new Date(trade.closeTime).getTime();

        let realizedPnl = null;
        if (this.trader) {
            realizedPnl = await this.trader.fetchRealizedPnl(symbol, entryTime, closeTime);
        }

        if (realizedPnl !== null) {
            // Use actual Binance PNL (includes all fees)
            trade.pnl = realizedPnl;
            logger.info(`Using actual Binance PNL for ${symbol}: ${realizedPnl} USDT`);
        } else {
            // Fallback to calculated PNL (without fees)
            const priceChange = trade.direction === 'LONG'
                ? (trade.closePrice - trade.entryPrice)
                : (trade.entryPrice - trade.closePrice);

            trade.pnl = priceChange * trade.quantity;
            logger.warn(`Using calculated PNL for ${symbol}: ${trade.pnl} USDT (Binance fetch failed)`);
        }

        // PNL % relative to position notional value
        const positionValue = trade.entryPrice * trade.quantity;
        trade.pnlPercent = (trade.pnl / positionValue) * 100;

        // ROI % relative to margin used (this is where leverage matters)
        const marginUsed = positionValue / trade.leverage;
        trade.roiPercent = (trade.pnl / marginUsed) * 100;

        // Add closing remark if provided
        if (closeData.remark) {
            trade.remarks.push({
                text: closeData.remark,
                timestamp: new Date().toISOString()
            });
        }

        this.saveTrades();

        logger.info(`Trade closed: ${trade.id} - PNL: ${trade.pnl.toFixed(2)} USDT (${trade.pnlPercent.toFixed(2)}%)`);
    }

    /**
     * Get all trades
     */
    getTrades(filters = {}) {
        let filtered = [...this.trades];

        // Filter by status
        if (filters.status) {
            filtered = filtered.filter(t => t.status === filters.status);
        }

        // Filter by symbol
        if (filters.symbol) {
            filtered = filtered.filter(t => t.symbol === filters.symbol);
        }

        // Filter by date range
        if (filters.startDate) {
            filtered = filtered.filter(t => new Date(t.entryTime) >= new Date(filters.startDate));
        }
        if (filters.endDate) {
            filtered = filtered.filter(t => new Date(t.entryTime) <= new Date(filters.endDate));
        }

        // Sort by entry time (newest first)
        filtered.sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));

        // Pagination
        if (filters.limit) {
            const offset = filters.offset || 0;
            filtered = filtered.slice(offset, offset + filters.limit);
        }

        return filtered;
    }

    /**
     * Get trade statistics
     */
    getStats() {
        const closedTrades = this.trades.filter(t => t.status === 'CLOSED');

        if (closedTrades.length === 0) {
            return {
                totalTrades: 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: 0,
                totalPnl: 0,
                avgPnl: 0,
                bestTrade: null,
                worstTrade: null
            };
        }

        const winningTrades = closedTrades.filter(t => t.pnl > 0);
        const losingTrades = closedTrades.filter(t => t.pnl <= 0);
        const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);

        const sortedByPnl = [...closedTrades].sort((a, b) => b.pnl - a.pnl);

        return {
            totalTrades: closedTrades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: (winningTrades.length / closedTrades.length) * 100,
            totalPnl: totalPnl,
            avgPnl: totalPnl / closedTrades.length,
            bestTrade: sortedByPnl[0],
            worstTrade: sortedByPnl[sortedByPnl.length - 1]
        };
    }
}

export default TradeLogger;
