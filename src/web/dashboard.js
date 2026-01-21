import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import winston from 'winston';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Custom Winston Transport to capture logs for the dashboard
class DashboardTransport extends winston.Transport {
    constructor(opts, callback) {
        super(opts);
        this.callback = callback;
    }

    log(info, callback) {
        setImmediate(() => {
            this.emit('logged', info);
        });

        if (this.callback) {
            // Extract clean message if possible, or use the formatted one
            // info.message is usually the raw message
            // info[Symbol.for('message')] is the formatted message
            const level = info.level.toUpperCase();
            const message = info.message;
            this.callback(level, message);
        }

        callback();
    }
}

/**
 * Web Dashboard Class
 */
class WebDashboard {
    constructor(trader, config, positionTracker, tradeLogger) {
        this.trader = trader;
        this.config = config;
        this.positionTracker = positionTracker;
        this.tradeLogger = tradeLogger;
        this.port = parseInt(config.WEB_PORT || 5000);
        this.app = express();
        this.server = null;
        this.envPath = path.join(__dirname, '../../.env');

        // Log streaming
        this.logBuffer = [];
        this.maxLogBufferSize = 1000;
        this.sseClients = [];

        // Intercept console        // Setup log capture
        this.setupConsoleInterception();
        this.setupLoggerInterception(); // Add Winston interception
    }

    /**
     * Start web server
     */
    start() {
        // Add JSON middleware
        this.app.use(express.json());

        // Home page - Dashboard
        this.app.get('/', (req, res) => {
            const dashboardPath = path.join(__dirname, 'dashboard.html');
            res.sendFile(dashboardPath);
        });

        // Settings page
        this.app.get('/settings', (req, res) => {
            const settingsPath = path.join(__dirname, 'settings.html');
            res.sendFile(settingsPath);
        });

        // Logs page
        this.app.get('/logs', (req, res) => {
            const logsPath = path.join(__dirname, 'logs.html');
            res.sendFile(logsPath);
        });

        // Journal page
        this.app.get('/journal', (req, res) => {
            const journalPath = path.join(__dirname, 'journal.html');
            res.sendFile(journalPath);
        });

        // API endpoint for positions
        this.app.get('/api/positions', async (req, res) => {
            try {
                const positions = await this.trader.monitoringClient.futuresPositionRisk();
                const openPositions = positions
                    .filter(pos => parseFloat(pos.positionAmt) !== 0)
                    .map(pos => ({
                        symbol: pos.symbol,
                        positionAmt: pos.positionAmt,
                        entryPrice: pos.entryPrice,
                        markPrice: pos.markPrice,
                        unrealizedProfit: pos.unRealizedProfit,
                        leverage: pos.leverage
                    }));

                res.json({ positions: openPositions });
            } catch (error) {
                logger.error(`Error fetching positions: ${error.message} `);
                res.status(500).json({ error: error.message });
            }
        });

        // API endpoint for open orders
        this.app.get('/api/orders', async (req, res) => {
            try {
                const orders = await this.trader.monitoringClient.futuresOpenOrders();
                res.json({ orders });
            } catch (error) {
                logger.error(`Error fetching orders: ${error.message} `);
                res.status(500).json({ error: error.message });
            }
        });

        // API endpoint for account info
        this.app.get('/api/account', async (req, res) => {
            try {
                const balance = await this.trader.getAccountBalance();
                res.json({ balance });
            } catch (error) {
                logger.error(`Error fetching account info: ${error.message} `);
                res.status(500).json({ error: error.message });
            }
        });

        // API endpoint to get configuration
        this.app.get('/api/config', (req, res) => {
            try {
                const envContent = fs.readFileSync(this.envPath, 'utf8');
                const config = this.parseEnvFile(envContent);
                res.json({ config });
            } catch (error) {
                logger.error(`Error reading config: ${error.message} `);
                res.status(500).json({ error: error.message });
            }
        });

        // API endpoint to update configuration
        this.app.post('/api/config', (req, res) => {
            try {
                const newConfig = req.body.config;

                // Validate required fields
                const required = ['API_ID', 'API_HASH', 'PHONE_NUMBER', 'CHANNEL_ID',
                    'TRADING_API_KEY', 'TRADING_SECRET_KEY',
                    'MONITORING_API_KEY', 'MONITORING_SECRET_KEY'];

                const missing = required.filter(key => !newConfig[key]);
                if (missing.length > 0) {
                    return res.status(400).json({
                        error: `Missing required fields: ${missing.join(', ')} `
                    });
                }

                // Create backup
                const backupPath = this.envPath + '.backup';
                fs.copyFileSync(this.envPath, backupPath);
                logger.info(`Created backup at ${backupPath} `);

                // Write new config
                const envContent = this.generateEnvFile(newConfig);
                fs.writeFileSync(this.envPath, envContent, 'utf8');

                logger.info('Configuration updated successfully');
                res.json({
                    success: true,
                    message: 'Configuration saved. Please restart the bot for changes to take effect.'
                });
            } catch (error) {
                logger.error(`Error updating config: ${error.message} `);
                res.status(500).json({ error: error.message });
            }
        });

        // API endpoint to close position
        this.app.post('/api/close-position', async (req, res) => {
            try {
                const { symbol } = req.body;

                if (!symbol) {
                    return res.status(400).json({ error: 'Symbol is required' });
                }

                // Cancel all orders for this symbol
                await this.trader.cancelAllOrders(symbol);

                // Get current position
                const positions = await this.trader.monitoringClient.futuresPositionRisk();
                const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

                if (!position) {
                    return res.json({ success: true, message: 'No open position found' });
                }

                // Close position with market order
                const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';
                const quantity = Math.abs(parseFloat(position.positionAmt));

                await this.trader.tradingClient.futuresOrder({
                    symbol,
                    side,
                    type: 'MARKET',
                    quantity: quantity.toString(),
                    reduceOnly: true
                });

                logger.info(`Closed position for ${symbol}`);
                res.json({ success: true, message: `Position closed for ${symbol}` });
            } catch (error) {
                logger.error(`Error closing position: ${error.message} `);
                res.status(500).json({ error: error.message });
            }
        });



        // API endpoint to emergency close all positions
        this.app.post('/api/emergency-close-all', async (req, res) => {
            if (!this.positionTracker) {
                return res.status(503).json({ error: 'Position tracker not initialized' });
            }
            try {
                const result = await this.positionTracker.emergencyCloseAll();
                res.json(result);
            } catch (error) {
                logger.error(`Error in emergency close all: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        // API endpoint to retry safety orders
        this.app.post('/api/retry-safety-orders', async (req, res) => {
            const { symbol } = req.body;
            if (!this.positionTracker) {
                return res.status(503).json({ error: 'Position tracker not initialized' });
            }
            try {
                // Trigger checkPositions which handles retries/unprotected
                await this.positionTracker.checkPositions();

                // Get updated status
                const unprotected = this.positionTracker.getUnprotectedPositions();
                const stillUnprotected = unprotected.find(p => p.symbol === symbol);

                if (stillUnprotected) {
                    res.json({ success: false, message: 'Retried but position is still unprotected. Check logs.' });
                } else {
                    res.json({ success: true, message: 'Safety orders check triggered. Please verify status.' });
                }

            } catch (error) {
                logger.error(`Error retrying safety orders: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        // API to get unprotected positions status
        this.app.get('/api/positions/unprotected', (req, res) => {
            if (!this.positionTracker) {
                return res.json([]);
            }
            res.json(this.positionTracker.getUnprotectedPositions());
        });

        // Trade journal endpoints
        this.app.get('/api/trades', (req, res) => {
            if (!this.tradeLogger) {
                return res.json({ trades: [] });
            }

            const filters = {
                status: req.query.status,
                symbol: req.query.symbol,
                startDate: req.query.startDate,
                endDate: req.query.endDate,
                limit: parseInt(req.query.limit) || 100,
                offset: parseInt(req.query.offset) || 0
            };

            const trades = this.tradeLogger.getTrades(filters);
            res.json({ trades });
        });

        this.app.get('/api/trades/stats', (req, res) => {
            if (!this.tradeLogger) {
                return res.json({
                    totalTrades: 0,
                    winningTrades: 0,
                    losingTrades: 0,
                    winRate: 0,
                    totalPnl: 0,
                    avgPnl: 0,
                    bestTrade: null,
                    worstTrade: null
                });
            }

            const stats = this.tradeLogger.getStats();
            res.json(stats);
        });

        // Logs API - Get log history
        this.app.get('/api/logs', (req, res) => {
            res.json({ logs: this.logBuffer });
        });

        // Logs API - SSE stream
        this.app.get('/api/logs/stream', (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            // Add client to subscribers
            const clientId = Date.now();
            const client = { id: clientId, res };
            this.sseClients.push(client);

            logger.info(`SSE client connected: ${clientId} `);

            // Send initial connection message
            res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })} \n\n`);

            // Remove client on disconnect
            req.on('close', () => {
                this.sseClients = this.sseClients.filter(c => c.id !== clientId);
                logger.info(`SSE client disconnected: ${clientId} `);
            });
        });

        // Start server
        this.server = this.app.listen(this.port, '0.0.0.0', () => {
            logger.info(`Web dashboard started at http://0.0.0.0:${this.port}`);
        });
    }

    /**
     * Setup intersection of Winston logger
     */
    setupLoggerInterception() {
        const transport = new DashboardTransport({}, (level, message) => {
            // Avoid duplication if console interception also catches it
            // Winston transport might log before or after console.log
            // We can check if we just logged this message? 
            // Actually, safe to just log it. Duplication is better than missing logs.
            // But we can filter out "HTTP" logs if we want.
            this.addLog(level, message);
        });

        logger.add(transport);
        logger.info('Dashboard logger interception enabled');
    }

    /**
     * Setup console interception for log capture
     */
    setupConsoleInterception() {
        const self = this;
        // Check if we haven't already intercepted
        if (console._intercepted) return;
        console._intercepted = true;

        // Store original console methods
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;
        const originalInfo = console.info;

        // Intercept console.log
        console.log = function (...args) {
            const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
            self.addLog('INFO', message);
            originalLog.apply(console, args);
        };

        // Intercept console.error
        console.error = function (...args) {
            const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
            self.addLog('ERROR', message);
            originalError.apply(console, args);
        };

        // Intercept console.warn
        console.warn = function (...args) {
            const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
            self.addLog('WARN', message);
            originalWarn.apply(console, args);
        };

        // Intercept console.info
        console.info = function (...args) {
            const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
            self.addLog('INFO', message);
            originalInfo.apply(console, args);
        };
    }

    /**
     * Add log entry to buffer and broadcast to SSE clients
     */
    addLog(level, message) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            message
        };

        // Add to buffer
        this.logBuffer.push(logEntry);

        // Trim buffer if too large
        if (this.logBuffer.length > this.maxLogBufferSize) {
            this.logBuffer.shift();
        }

        // Broadcast to SSE clients
        this.broadcastLog(logEntry);
    }

    /**
     * Broadcast log to all connected SSE clients
     */
    broadcastLog(logEntry) {
        const data = `data: ${JSON.stringify(logEntry)}\n\n`;
        this.sseClients.forEach(client => {
            try {
                client.res.write(data);
            } catch (error) {
                // Client disconnected, will be removed on next cleanup
            }
        });
    }

    /**
     * Parse .env file content into key-value pairs
     */
    parseEnvFile(content) {
        const config = {};
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith('#')) continue;

            const equalIndex = trimmed.indexOf('=');
            if (equalIndex > 0) {
                const key = trimmed.substring(0, equalIndex).trim();
                const value = trimmed.substring(equalIndex + 1).trim();
                config[key] = value;
            }
        }

        return config;
    }

    /**
     * Generate .env file content from config object
     */
    generateEnvFile(config) {
        let content = '# Environment Variables for TrustTrade JavaScript Bot\n\n';

        // Group configurations
        const groups = {
            'Telegram Configuration': ['API_ID', 'API_HASH', 'PHONE_NUMBER', 'CHANNEL_ID'],
            'Binance API Keys': ['TRADING_API_KEY', 'TRADING_SECRET_KEY', 'MONITORING_API_KEY', 'MONITORING_SECRET_KEY'],
            'Trading Mode': ['TRADING_MODE'],
            'Position & Risk Management': ['MAX_OPEN_POSITIONS', 'MAX_OPEN_ENTRY_ORDERS', 'MIN_BALANCE', 'MARGIN_THRESHOLD', 'TARGET_MARGIN_PER_TRADE', 'DEFAULT_LEVERAGE', 'MAX_LEVERAGE', 'MAX_TOTAL_NOTIONAL'],
            'Stop Loss & Take Profit': ['SL_PERCENTAGE', 'TRAILING_SL_TRIGGER', 'TP1_ROI', 'TP2_ROI', 'MIN_RISK_REWARD'],
            'Filters': ['ENABLE_RISK_REWARD_FILTER', 'ENABLE_VOLATILITY_FILTER', 'ENABLE_SPREAD_FILTER', 'ENABLE_TIME_FILTER', 'ENABLE_TREND_FILTER', 'ENABLE_CANDLE_WICK_FILTER', 'ENABLE_VOLUME_SPIKE_DETECTION'],
            'Volatility Filters': ['MAX_ATR_PERCENT', 'MAX_VOLATILITY_PERCENT', 'MAX_SPREAD_PERCENT', 'MIN_FUNDING_RATE', 'MAX_FUNDING_RATE'],
            'Telegram Alerts': ['ALERT_BOT_TOKEN', 'ALERT_CHAT_ID', 'ALERT_LEVEL'],
            'API Rate Limiting': ['API_REQUEST_DELAY', 'MAX_REQUESTS_PER_MINUTE'],
            'Trade Frequency': ['MAX_TRADES_PER_HOUR', 'TRADE_COOLDOWN_SECONDS'],
            'Deduplication': ['DEDUPLICATION_WINDOW'],
            'Web Dashboard': ['WEB_PORT']
        };

        for (const [groupName, keys] of Object.entries(groups)) {
            content += `# ${groupName}\n`;
            for (const key of keys) {
                if (config[key] !== undefined) {
                    content += `${key}=${config[key]}\n`;
                }
            }
            content += '\n';
        }

        return content;
    }

    /**
     * Generate dashboard HTML
     */

    generateDashboardHTML() {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="10">
    <title>TrustTrade Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        h1 {
            color: white;
            text-align: center;
            margin-bottom: 30px;
            font-size: 2.5em;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        
        .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        
        h2 {
            color: #667eea;
            margin-bottom: 20px;
            font-size: 1.8em;
            border-bottom: 3px solid #667eea;
            padding-bottom: 10px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e0e0e0;
        }
        
        th {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            font-weight: 600;
            text-transform: uppercase;
            font-size: 0.9em;
            letter-spacing: 0.5px;
        }
        
        tr:hover {
            background-color: #f5f5f5;
        }
        
        .no-data {
            text-align: center;
            color: #999;
            font-style: italic;
            padding: 30px;
        }
        
        .positive {
            color: #10b981;
            font-weight: bold;
        }
        
        .negative {
            color: #ef4444;
            font-weight: bold;
        }
        
        .status {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
        }
        
        .status.active {
            background: #10b981;
            color: white;
        }
        
        .refresh-info {
            text-align: center;
            color: white;
            margin-top: 20px;
            font-size: 0.9em;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }
        
        .stat-box {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        
        .stat-value {
            font-size: 2em;
            font-weight: bold;
            margin-bottom: 5px;
        }
        
        .stat-label {
            font-size: 0.9em;
            opacity: 0.9;
        }

        .nav {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
            justify-content: center;
        }

        .nav a {
            background: rgba(255,255,255,0.2);
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 10px;
            font-size: 1.1em;
            font-weight: 600;
            transition: all 0.3s;
        }

        .nav a:hover { background: rgba(255,255,255,0.3); }
        .nav a.active { background: white; color: #667eea; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 TrustTrade Dashboard</h1>
        
        <div class="nav">
            <a href="/" class="active">Dashboard</a>
            <a href="/settings">Settings</a>
        </div>
        
        <div class="card">
            <div class="stats" id="stats">
                <div class="stat-box">
                    <div class="stat-value" id="balance">Loading...</div>
                    <div class="stat-label">Available Balance (USDT)</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="positions-count">0</div>
                    <div class="stat-label">Open Positions</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="orders-count">0</div>
                    <div class="stat-label">Open Orders</div>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>📊 Current Positions</h2>
            <div id="positions-table">
                <p class="no-data">Loading positions...</p>
            </div>
        </div>
        
        <div class="card">
            <h2>📝 Open Orders</h2>
            <div id="orders-table">
                <p class="no-data">Loading orders...</p>
            </div>
        </div>
        
        <p class="refresh-info">⏱️ Auto-refreshing every 10 seconds</p>
    </div>
    
    <script>
        async function loadData() {
            try {
                // Load account balance
                const accountRes = await fetch('/api/account');
                const accountData = await accountRes.json();
                document.getElementById('balance').textContent = accountData.balance.toFixed(2);
                
                // Load positions
                const posRes = await fetch('/api/positions');
                const posData = await posRes.json();
                
                document.getElementById('positions-count').textContent = posData.positions.length;
                
                if (posData.positions.length > 0) {
                    let html = '<table><tr><th>Symbol</th><th>Amount</th><th>Entry Price</th><th>Mark Price</th><th>PNL</th><th>Leverage</th></tr>';
                    posData.positions.forEach(pos => {
                        const pnl = parseFloat(pos.unrealizedProfit);
                        const pnlClass = pnl >= 0 ? 'positive' : 'negative';
                        html += \`<tr>
                            <td><strong>\${pos.symbol}</strong></td>
                            <td>\${pos.positionAmt}</td>
                            <td>\${parseFloat(pos.entryPrice).toFixed(4)}</td>
                            <td>\${parseFloat(pos.markPrice).toFixed(4)}</td>
                            <td class="\${pnlClass}">\${pnl.toFixed(2)} USDT</td>
                            <td>\${pos.leverage}x</td>
                        </tr>\`;
                    });
                    html += '</table>';
                    document.getElementById('positions-table').innerHTML = html;
                } else {
                    document.getElementById('positions-table').innerHTML = '<p class="no-data">No open positions</p>';
                }
                
                // Load orders
                const ordersRes = await fetch('/api/orders');
                const ordersData = await ordersRes.json();
                
                document.getElementById('orders-count').textContent = ordersData.orders.length;
                
                if (ordersData.orders.length > 0) {
                    let html = '<table><tr><th>Symbol</th><th>Type</th><th>Side</th><th>Price</th><th>Quantity</th><th>Status</th></tr>';
                    ordersData.orders.forEach(order => {
                        html += \`<tr>
                            <td><strong>\${order.symbol}</strong></td>
                            <td>\${order.type}</td>
                            <td>\${order.side}</td>
                            <td>\${parseFloat(order.price || order.stopPrice || 0).toFixed(4)}</td>
                            <td>\${order.origQty}</td>
                            <td><span class="status active">\${order.status}</span></td>
                        </tr>\`;
                    });
                    html += '</table>';
                    document.getElementById('orders-table').innerHTML = html;
                } else {
                    document.getElementById('orders-table').innerHTML = '<p class="no-data">No open orders</p>';
                }
                
            } catch (error) {
                console.error('Error loading data:', error);
            }
        }
        
        // Load data on page load
        loadData();
        
        // Refresh every 10 seconds
        setInterval(loadData, 10000);
    </script>
</body>
</html>
        `;
    }

    /**
     * Stop web server
     */
    stop() {
        if (this.server) {
            this.server.close();
            logger.info('Web dashboard stopped');
        }
    }
}

export default WebDashboard;
