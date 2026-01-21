import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import logger from '../utils/logger.js';
import TelegramSignalParser from '../parsers/signalParser.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Telegram Client - Connects to Telegram and listens for signals
 */
class TelegramSignalBot {
    constructor(config, signalHandler) {
        this.apiId = parseInt(config.API_ID);
        this.apiHash = config.API_HASH;
        this.phoneNumber = config.PHONE_NUMBER;
        this.channelId = config.CHANNEL_ID;
        this.signalHandler = signalHandler;

        this.parser = new TelegramSignalParser();
        this.client = null;
        this.sessionFile = path.join(__dirname, '../../.telegram_session');
        this.session = this.loadSession();
        this.processedSignals = new Map();
        this.deduplicationWindow = parseInt(config.DEDUPLICATION_WINDOW || 600) * 1000; // Convert to ms
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 3;
    }

    /**
     * Load session from file if it exists
     */
    loadSession() {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const sessionString = fs.readFileSync(this.sessionFile, 'utf8');
                logger.info('Loading existing Telegram session...');
                return new StringSession(sessionString);
            }
        } catch (error) {
            logger.warn(`Could not load session file: ${error.message}`);
        }
        logger.info('Starting with new Telegram session...');
        return new StringSession('');
    }

    /**
     * Save session to file
     */
    saveSession() {
        try {
            if (this.client && this.client.session) {
                const sessionString = this.client.session.save();
                fs.writeFileSync(this.sessionFile, sessionString, 'utf8');
                logger.info('Telegram session saved successfully');
            }
        } catch (error) {
            logger.error(`Failed to save session: ${error.message}`);
        }
    }

    /**
     * Clear session file
     */
    clearSession() {
        try {
            if (fs.existsSync(this.sessionFile)) {
                fs.unlinkSync(this.sessionFile);
                logger.info('Session file deleted');
            }
            this.session = new StringSession('');
        } catch (error) {
            logger.error(`Failed to clear session: ${error.message}`);
        }
    }

    /**
     * Connect to Telegram with retry logic
     */
    async connect() {
        while (this.connectionAttempts < this.maxConnectionAttempts) {
            try {
                this.connectionAttempts++;
                logger.info(`Connecting to Telegram (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts}) with phone: ${this.phoneNumber}`);

                this.client = new TelegramClient(
                    this.session,
                    this.apiId,
                    this.apiHash,
                    {
                        connectionRetries: 5,
                        retryDelay: 2000,
                        timeout: 30000,
                        autoReconnect: true,
                        useWSS: false
                    }
                );

                await this.client.start({
                    phoneNumber: async () => this.phoneNumber,
                    password: async () => await input.text('Please enter your password: '),
                    phoneCode: async () => await input.text('Please enter the code you received: '),
                    onError: (err) => {
                        logger.error(`Telegram auth error: ${err.message}`);
                        // If we get a security/nonce error, clear the session
                        if (err.message.includes('nonce') || err.message.includes('SecurityError')) {
                            logger.warn('Security error detected - clearing session for fresh start');
                            this.clearSession();
                        }
                    },
                });

                logger.info('✅ Connected to Telegram successfully!');

                // Save session for future use
                this.saveSession();

                // Reset connection attempts on success
                this.connectionAttempts = 0;
                return;

            } catch (error) {
                logger.error(`Failed to connect to Telegram (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts}): ${error.message}`);

                // If it's a security/nonce error, clear session and retry
                if (error.message.includes('nonce') || error.message.includes('SecurityError') || error.message.includes('Step 3')) {
                    logger.warn('⚠️ Security/authentication error detected - clearing session');
                    this.clearSession();

                    if (this.connectionAttempts < this.maxConnectionAttempts) {
                        const delay = 3000 * this.connectionAttempts; // Exponential backoff
                        logger.info(`Waiting ${delay}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }

                if (this.connectionAttempts >= this.maxConnectionAttempts) {
                    logger.error('❌ Max connection attempts reached. Please try again later.');
                    throw error;
                }

                // Wait before retry
                const delay = 3000 * this.connectionAttempts;
                logger.info(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Get channel entity
     */
    async getChannel() {
        try {
            logger.info(`Resolving channel: ${this.channelId}`);

            let channel;
            if (this.channelId.startsWith('@')) {
                // Public channel by username
                channel = await this.client.getEntity(this.channelId);
            } else if (this.channelId.includes(':')) {
                // Channel ID with access hash format: "channelId:accessHash"
                const [channelIdStr, accessHashStr] = this.channelId.split(':');
                const channelId = BigInt(channelIdStr);
                const accessHash = BigInt(accessHashStr);

                // Import Api for InputChannel
                const { Api } = await import('telegram');

                // Create InputChannel
                const inputChannel = new Api.InputChannel({
                    channelId: channelId,
                    accessHash: accessHash
                });

                channel = await this.client.getEntity(inputChannel);
            } else {
                // Plain channel ID (try with -100 prefix for supergroups/channels)
                let channelId = this.channelId;

                // If it doesn't start with -100, add it
                if (!channelId.startsWith('-100')) {
                    channelId = `-100${channelId}`;
                }

                channel = await this.client.getEntity(parseInt(channelId));
            }

            logger.info(`Channel resolved: ${channel.title || 'Unknown'}`);
            return channel;

        } catch (error) {
            logger.error(`Failed to resolve channel: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Check if signal is duplicate
     */
    isDuplicateSignal(signal) {
        const key = `${signal.coin}_${signal.entryPrices.join('_')}`;
        const now = Date.now();

        if (this.processedSignals.has(key)) {
            const lastTimestamp = this.processedSignals.get(key);
            if (now - lastTimestamp < this.deduplicationWindow) {
                logger.info(`Duplicate signal detected for ${signal.coin}. Skipping.`);
                return true;
            }
        }

        this.processedSignals.set(key, now);

        // Clean up old entries
        for (const [k, timestamp] of this.processedSignals.entries()) {
            if (now - timestamp > this.deduplicationWindow) {
                this.processedSignals.delete(k);
            }
        }

        return false;
    }

    /**
     * Listen to channel for new messages
     */
    async listenToChannel() {
        try {
            const channel = await this.getChannel();

            logger.info(`Listening to channel: ${channel.title || 'Unknown'}...`);

            // Import NewMessage event
            const { NewMessage } = await import('telegram/events/index.js');

            // Add event handler for new messages from this specific channel only
            this.client.addEventHandler(async (event) => {
                try {
                    if (!event.message) return;

                    // Verify message is from the target channel
                    const chatId = event.message.peerId?.channelId?.toString();
                    const targetChannelId = this.channelId.split(':')[0]; // Get channel ID part

                    if (chatId !== targetChannelId) {
                        logger.debug(`Ignoring message from different channel: ${chatId}`);
                        return;
                    }

                    const messageText = event.message.message;
                    const messageTimestamp = event.message.date * 1000; // Convert to ms

                    logger.debug(`New message received from target channel: ${messageText.substring(0, 100)}...`);

                    // Parse the message
                    const signal = this.parser.parseMessage(messageText, messageTimestamp);

                    if (signal) {
                        // Check for duplicates
                        if (this.isDuplicateSignal(signal)) {
                            return;
                        }

                        logger.info(`Valid signal detected:\n${JSON.stringify(signal, null, 2)}`);

                        // Handle TP signals
                        if (signal.isTakeProfit) {
                            if (signal.message.includes('Closed due to opposite direction')) {
                                logger.info(`Received 'Closed due to opposite direction' signal for ${signal.coin}`);
                                // Let the signal handler deal with this
                                await this.signalHandler(signal);
                            } else {
                                logger.info(`Ignoring TP signal for ${signal.coin} (profit ${signal.profit}%). Bot uses own TP1/TP2 system.`);
                            }
                        } else {
                            // Regular entry signal
                            await this.signalHandler(signal);
                        }
                    }

                } catch (error) {
                    logger.error(`Error processing message: ${error.message}`, error);
                }
            }, new NewMessage({}));

            logger.info('Event handler registered. Client listening for messages from target channel only...');

        } catch (error) {
            logger.error(`Error in listenToChannel: ${error.message}`, error);
            // Reconnect after delay
            logger.info('Reconnecting in 10 seconds...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            await this.connect();
            await this.listenToChannel();
        }
    }

    /**
     * Disconnect from Telegram
     */
    async disconnect() {
        if (this.client) {
            await this.client.disconnect();
            logger.info('Disconnected from Telegram');
        }
    }
}

export default TelegramSignalBot;
