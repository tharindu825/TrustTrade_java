import BinanceAPI from 'binance-api-node';
import logger from '../utils/logger.js';

const Binance = BinanceAPI.default || BinanceAPI;

/**
 * Binance Trading Client - Handles all Binance API interactions
 */
class BinanceTrader {
    constructor(config) {
        this.config = config;
        this.tradingClient = null;
        this.monitoringClient = null;

        // Trading parameters
        this.maxOpenPositions = parseInt(config.MAX_OPEN_POSITIONS || 1);
        this.defaultLeverage = parseInt(config.DEFAULT_LEVERAGE || 20);
        this.maxLeverage = parseInt(config.MAX_LEVERAGE || 20);
        this.slPercentage = parseFloat(config.SL_PERCENTAGE || 0.07);
        this.tp1Roi = parseFloat(config.TP1_ROI || 0.5);
        this.tp2Roi = parseFloat(config.TP2_ROI || 2.0);
        this.minRiskReward = parseFloat(config.MIN_RISK_REWARD || 1.5);
        this.targetMarginPerTrade = parseFloat(config.TARGET_MARGIN_PER_TRADE || 1.0);

        // State tracking
        this.openPositions = new Map();
        this.placedOrders = new Map();
        this.tpOrders = new Map();
        this.slOrders = new Map();
        this.validSymbols = new Set();
        this.symbolPrecision = new Map(); // Cache for symbol precision
        this.exchangeInfo = null; // Cache exchange info

        // Rate limiting
        this.lastApiRequestTime = 0;
        this.apiRequestDelay = parseFloat(config.API_REQUEST_DELAY || 0.5) * 1000; // Convert to ms
    }

    /**
     * Initialize Binance clients
     */
    async initialize() {
        try {
            logger.info('Initializing Binance clients...');

            // Trading client
            this.tradingClient = Binance({
                apiKey: this.config.TRADING_API_KEY,
                apiSecret: this.config.TRADING_SECRET_KEY,
                futures: true,
                recvWindow: 60000 // Increase receive window to 60s to prevent timestamp errors
            });

            // Monitoring client
            this.monitoringClient = Binance({
                apiKey: this.config.MONITORING_API_KEY,
                apiSecret: this.config.MONITORING_SECRET_KEY,
                futures: true,
                recvWindow: 60000 // Increase receive window to 60s
            });

            // Test connection
            await this.tradingClient.futuresAccountInfo();
            logger.info('Trading client authenticated successfully');

            await this.monitoringClient.futuresAccountInfo();
            logger.info('Monitoring client authenticated successfully');

            // Cache valid symbols
            await this.cacheValidSymbols();

        } catch (error) {
            logger.error(`Failed to initialize Binance clients: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Cache valid trading symbols and their precision
     */
    async cacheValidSymbols() {
        try {
            this.exchangeInfo = await this.monitoringClient.futuresExchangeInfo();

            // Cache valid symbols
            this.validSymbols = new Set(
                this.exchangeInfo.symbols
                    .filter(s => s.status === 'TRADING')
                    .map(s => s.symbol)
            );

            // Cache symbol precision and filters
            for (const symbol of this.exchangeInfo.symbols) {
                if (symbol.status === 'TRADING') {
                    const pricePrecision = symbol.pricePrecision;
                    const quantityPrecision = symbol.quantityPrecision;
                    
                    // Get tick size and step size from filters
                    const priceFilter = symbol.filters.find(f => f.filterType === 'PRICE_FILTER');
                    const lotSizeFilter = symbol.filters.find(f => f.filterType === 'LOT_SIZE');
                    
                    const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : null;
                    const stepSize = lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : null;

                    this.symbolPrecision.set(symbol.symbol, {
                        price: pricePrecision,
                        quantity: quantityPrecision,
                        tickSize: tickSize,
                        stepSize: stepSize
                    });
                }
            }

            logger.info(`Cached ${this.validSymbols.size} valid trading symbols with precision data`);
        } catch (error) {
            logger.error(`Error caching valid symbols: ${error.message}`, error);
        }
    }

    /**
     * Validate if symbol is tradable
     */
    async validateSymbol(symbol) {
        if (this.validSymbols.has(symbol)) {
            return true;
        }

        // Refresh cache and check again
        await this.cacheValidSymbols();
        return this.validSymbols.has(symbol);
    }

    /**
     * Format price according to symbol precision and tick size
     */
    formatPrice(symbol, price) {
        const precision = this.symbolPrecision.get(symbol);
        if (!precision) {
            logger.warn(`No precision data for ${symbol}, using default`);
            return parseFloat(price.toFixed(4));
        }
        
        // If tick size is available, round to nearest tick
        if (precision.tickSize) {
            const rounded = Math.round(price / precision.tickSize) * precision.tickSize;
            return parseFloat(rounded.toFixed(precision.price));
        }
        
        return parseFloat(price.toFixed(precision.price));
    }

    /**
     * Format quantity according to symbol precision and step size
     */
    formatQuantity(symbol, quantity) {
        const precision = this.symbolPrecision.get(symbol);
        if (!precision) {
            logger.warn(`No precision data for ${symbol}, using default`);
            return parseFloat(quantity.toFixed(3));
        }
        
        // If step size is available, round to nearest step
        if (precision.stepSize) {
            const rounded = Math.round(quantity / precision.stepSize) * precision.stepSize;
            return parseFloat(rounded.toFixed(precision.quantity));
        }
        
        return parseFloat(quantity.toFixed(precision.quantity));
    }

    /**
     * Rate limiting for API requests
     */
    async throttleApiRequest() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastApiRequestTime;

        if (timeSinceLastRequest < this.apiRequestDelay) {
            const delay = this.apiRequestDelay - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        this.lastApiRequestTime = Date.now();
    }

    /**
     * Get current open positions count
     */
    async getOpenPositionsCount() {
        try {
            await this.throttleApiRequest();
            const positions = await this.monitoringClient.futuresPositionRisk();
            const openPositions = positions.filter(pos => parseFloat(pos.positionAmt) !== 0);
            logger.info(`Current open positions: ${openPositions.length}`);
            return openPositions.length;
        } catch (error) {
            logger.error(`Error fetching open positions: ${error.message}`, error);
            return 0;
        }
    }

    /**
     * Check if symbol has open position
     */
    async hasSymbolPosition(symbol) {
        try {
            await this.throttleApiRequest();
            const positions = await this.monitoringClient.futuresPositionRisk();
            const position = positions.find(pos =>
                pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0
            );
            return !!position;
        } catch (error) {
            logger.error(`Error checking position for ${symbol}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * Get position direction for a symbol
     */
    async getPositionDirection(symbol) {
        try {
            await this.throttleApiRequest();
            const positions = await this.monitoringClient.futuresPositionRisk();
            const position = positions.find(pos => pos.symbol === symbol);

            if (!position) return null;

            const positionAmt = parseFloat(position.positionAmt);
            if (positionAmt === 0) return null;

            return positionAmt > 0 ? 'LONG' : 'SHORT';
        } catch (error) {
            logger.error(`Error getting position direction for ${symbol}: ${error.message}`);
            return null;
        }
    }

    /**
     * Get position details for a symbol
     */
    async getPosition(symbol) {
        try {
            await this.throttleApiRequest();
            const positions = await this.monitoringClient.futuresPositionRisk();
            const position = positions.find(pos => pos.symbol === symbol);

            if (!position) return null;

            const positionAmt = parseFloat(position.positionAmt);
            if (positionAmt === 0) return null;

            return position;
        } catch (error) {
            logger.error(`Error getting position for ${symbol}: ${error.message}`);
            return null;
        }
    }

    /**
     * Get account balance
     */
    async getAccountBalance() {
        try {
            await this.throttleApiRequest();
            const accountInfo = await this.monitoringClient.futuresAccountBalance();
            const usdtBalance = accountInfo.find(b => b.asset === 'USDT');
            return parseFloat(usdtBalance?.availableBalance || 0);
        } catch (error) {
            logger.error(`Error fetching account balance: ${error.message}`, error);
            return 0;
        }
    }

    /**
     * Set leverage for symbol
     */
    async setLeverage(symbol, leverage) {
        try {
            await this.throttleApiRequest();
            await this.tradingClient.futuresLeverage({
                symbol,
                leverage
            });
            logger.info(`Set leverage to ${leverage}x for ${symbol}`);
            return true;
        } catch (error) {
            logger.error(`Error setting leverage for ${symbol}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * Set margin type (ISOLATED or CROSSED)
     */
    async setMarginType(symbol, marginType = 'ISOLATED') {
        try {
            await this.throttleApiRequest();
            await this.tradingClient.futuresMarginType({
                symbol,
                marginType
            });
            logger.info(`Set margin type to ${marginType} for ${symbol}`);
            return true;
        } catch (error) {
            // Error -4046 means margin type is already set
            if (error.code === -4046) {
                logger.debug(`Margin type already set for ${symbol}`);
                return true;
            }
            logger.error(`Error setting margin type for ${symbol}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * Calculate position size based on available balance and risk
     */
    async calculatePositionSize(symbol, entryPrice, leverage) {
        try {
            const balance = await this.getAccountBalance();
            const marginToUse = this.targetMarginPerTrade;

            // Calculate quantity
            const notionalValue = marginToUse * leverage;
            const quantity = notionalValue / entryPrice;

            // Get symbol info for precision
            const exchangeInfo = await this.monitoringClient.futuresExchangeInfo();
            const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);

            if (!symbolInfo) {
                throw new Error(`Symbol info not found for ${symbol}`);
            }

            // Round to proper precision
            const stepSize = parseFloat(symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize);
            const precision = stepSize.toString().split('.')[1]?.length || 0;
            const roundedQuantity = parseFloat(quantity.toFixed(precision));

            logger.info(`Calculated position size for ${symbol}: ${roundedQuantity} (notional: $${notionalValue.toFixed(2)})`);

            return roundedQuantity;

        } catch (error) {
            logger.error(`Error calculating position size: ${error.message}`, error);
            return 0;
        }
    }

    /**
     * Emergency close single position
     */
    async emergencyCloseSinglePosition(symbol) {
        try {
            const position = await this.getPosition(symbol);
            if (!position || parseFloat(position.positionAmt) === 0) {
                logger.warn(`No open position found for ${symbol}`);
                return { success: false, message: 'No position found' };
            }

            const quantity = Math.abs(parseFloat(position.positionAmt));
            const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';

            await this.tradingClient.futuresOrder({
                symbol,
                side,
                type: 'MARKET',
                quantity: this.formatQuantity(symbol, quantity),
                reduceOnly: true
            });

            logger.info(`✅ Emergency closed position for ${symbol}`);
            return { success: true, message: `Closed ${quantity} ${symbol}` };

        } catch (error) {
            logger.error(`Failed to emergency close ${symbol}: ${error.message}`, error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Fetch actual realized PNL from Binance for a specific trade
     * This includes all fees (trading fees, funding fees, etc.)
     * @param {string} symbol - Trading symbol
     * @param {number} startTime - Start timestamp in milliseconds
     * @param {number} endTime - End timestamp in milliseconds
     * @returns {Promise<number>} - Actual realized PNL in USDT
     */
    async fetchRealizedPnl(symbol, startTime, endTime) {
        try {
            await this.throttleApiRequest();

            // Fetch income history for REALIZED_PNL
            const income = await this.monitoringClient.futuresIncome({
                symbol,
                incomeType: 'REALIZED_PNL',
                startTime: startTime,
                endTime: endTime,
                limit: 100
            });

            // Sum all realized PNL entries for this time period
            let totalPnl = 0;
            if (income && income.length > 0) {
                totalPnl = income.reduce((sum, entry) => sum + parseFloat(entry.income), 0);
                logger.info(`Fetched realized PNL for ${symbol}: ${totalPnl} USDT (${income.length} entries)`);
            } else {
                logger.warn(`No realized PNL data found for ${symbol} in time range`);
            }

            return totalPnl;

        } catch (error) {
            logger.error(`Failed to fetch realized PNL for ${symbol}: ${error.message}`);
            // Return null to indicate fetch failed, caller can fall back to calculated PNL
            return null;
        }
    }

    /**
     * Place limit order
     */
    async placeLimitOrder(symbol, side, quantity, price) {
        try {
            await this.throttleApiRequest();

            const order = await this.tradingClient.futuresOrder({
                symbol,
                side,
                type: 'LIMIT',
                quantity,
                price,
                timeInForce: 'GTC'
            });

            logger.info(`Placed limit order: ${side} ${quantity} ${symbol} @ ${price} (Order ID: ${order.orderId})`);
            return order;

        } catch (error) {
            logger.error(`Error placing limit order for ${symbol}: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Place stop-loss order using STOP_MARKET with reduceOnly
     * Using quantity with reduceOnly=true for API compatibility
     */
    async placeStopLoss(symbol, side, quantity, stopPrice) {
        try {
            await this.throttleApiRequest();

            // Format price and quantity to correct precision
            const formattedPrice = this.formatPrice(symbol, stopPrice);
            const formattedQuantity = this.formatQuantity(symbol, quantity);

            logger.info(`Placing SL order: ${side} ${formattedQuantity} ${symbol} @ ${formattedPrice} (reduceOnly)`);

            // Use quantity with reduceOnly=true instead of closePosition
            // This is the correct API pattern for STOP_MARKET orders
            const order = await this.tradingClient.futuresOrder({
                symbol,
                side,
                type: 'STOP_MARKET',
                stopPrice: formattedPrice.toString(),
                quantity: formattedQuantity.toString(),
                reduceOnly: true,  // Only reduce position, don't open new
                workingType: 'MARK_PRICE'  // Use mark price to avoid manipulation
            });

            logger.info(`✅ SL order placed successfully (Order ID: ${order.orderId})`);
            return order;

        } catch (error) {
            logger.error(`❌ Error placing SL order for ${symbol}: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Place take-profit order using LIMIT order with reduceOnly
     */
    async placeTakeProfit(symbol, side, quantity, price) {
        try {
            await this.throttleApiRequest();

            // Format price and quantity to correct precision
            const formattedPrice = this.formatPrice(symbol, price);
            const formattedQuantity = this.formatQuantity(symbol, quantity);

            logger.info(`Placing TP order: ${side} ${formattedQuantity} ${symbol} @ ${formattedPrice}`);

            const order = await this.tradingClient.futuresOrder({
                symbol,
                side,
                type: 'LIMIT',
                quantity: formattedQuantity.toString(),
                price: formattedPrice.toString(),
                reduceOnly: true,
                timeInForce: 'GTC'
            });

            logger.info(`✅ TP order placed successfully (Order ID: ${order.orderId})`);
            return order;

        } catch (error) {
            logger.error(`❌ Error placing TP order for ${symbol}: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Cancel order
     */
    async cancelOrder(symbol, orderId) {
        try {
            await this.throttleApiRequest();
            await this.tradingClient.futuresCancelOrder({
                symbol,
                orderId
            });
            logger.info(`Canceled order ${orderId} for ${symbol}`);
            return true;
        } catch (error) {
            logger.error(`Error canceling order ${orderId} for ${symbol}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * Get open orders for symbol
     */
    async getOpenOrders(symbol) {
        try {
            await this.throttleApiRequest();
            const orders = await this.monitoringClient.futuresOpenOrders({ symbol });
            return orders;
        } catch (error) {
            logger.error(`Error fetching open orders for ${symbol}: ${error.message}`, error);
            return [];
        }
    }

    /**
     * Cancel all orders for symbol
     */
    async cancelAllOrders(symbol) {
        try {
            const orders = await this.getOpenOrders(symbol);

            for (const order of orders) {
                await this.cancelOrder(symbol, order.orderId);
            }

            logger.info(`Canceled all orders for ${symbol}`);
            return true;

        } catch (error) {
            logger.error(`Error canceling all orders for ${symbol}: ${error.message}`, error);
            return false;
        }
    }
}

export default BinanceTrader;
