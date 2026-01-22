/**
 * WhatsApp Manager - Baileys Version (No Chromium Required)
 * Uses @whiskeysockets/baileys for WhatsApp Web connection
 * Focused on minimal RAM usage and reliable session persistence
 * Database-backed session storage for ephemeral environments
 */

// ============================================================================
// MUST BE FIRST: Suppress noisy Baileys/Signal debug output BEFORE loading Baileys
// ============================================================================
const util = require('util');
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Signal protocol noise patterns to suppress
const SIGNAL_NOISE_PATTERNS = [
  'Closing session:',
  'Closing session',
  'Closing open session',
  'SessionEntry {',
  'SessionEntry',
  '_chains:',
  '_chains',
  'registrationId',
  'currentRatchet',
  'ephemeralKeyPair',
  'indexInfo',
  'pendingPreKey',
  'rootKey',
  'chainKey',
  'baseKey',
  'remoteIdentityKey'
];

function isSignalNoise(args) {
  // Quick check for common string patterns first
  const firstArg = args[0];
  if (typeof firstArg === 'string') {
    if (firstArg.startsWith('Closing session') || 
        firstArg.includes('SessionEntry') ||
        firstArg.includes('_chains')) return true;
  }
  
  // Check first arg if object
  if (firstArg && typeof firstArg === 'object') {
    if (firstArg._chains || firstArg.registrationId || firstArg.currentRatchet || 
        firstArg.indexInfo || firstArg.pendingPreKey || firstArg.ephemeralKeyPair) return true;
    if (firstArg.constructor?.name === 'SessionEntry') return true;
  }
  
  // Convert all args to string and check patterns
  const fullStr = args.map(a => {
    if (typeof a === 'string') return a;
    if (a === null || a === undefined) return '';
    try { return util.inspect(a, { depth: 2, maxStringLength: 500 }); } catch { return ''; }
  }).join(' ');
  
  return SIGNAL_NOISE_PATTERNS.some(p => fullStr.includes(p));
}

console.log = (...args) => {
  if (isSignalNoise(args)) return;
  originalConsoleLog.apply(console, args);
};

console.error = (...args) => {
  const str = args.map(a => typeof a === 'string' ? a : (a?.message || '')).join(' ');
  if (str.includes('Failed to decrypt') || str.includes('Bad MAC') || 
      str.includes('Session error') || str.includes('no sessions')) return;
  originalConsoleError.apply(console, args);
};
// ============================================================================

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidDecode, proto, generateWAMessageFromContent } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');
const axios = require('axios');
const logger = require('./logger');
const webhookDeliveryService = require('./webhookDeliveryService');
const chatbotManager = require('./chatbot');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

// CRITICAL FIX: Message retry counter cache (separate from message store!)
// This tracks how many times each message has been retried for encryption
// TTL prevents memory leaks, stdTTL is in seconds
const msgRetryCounterCache = new NodeCache({ stdTTL: 600, checkperiod: 60 }); // 10 min TTL

// LID to Phone Number mapping cache (in-memory with size limit)
const lidPhoneCache = new Map();
const LID_CACHE_MAX_SIZE = 10000; // Prevent unbounded growth

/**
 * Get actual phone number from any JID format
 * For @lid contacts, looks up from cache or returns LID
 * @param {string} jid - The JID (can be @lid, @s.whatsapp.net, @c.us, etc.)
 * @returns {string} Phone number with country code (e.g., "918949171377")
 */
function getPhoneNumber(jid) {
  if (!jid) return null;
  
  // Parse the JID
  const decoded = jidDecode(jid);
  if (!decoded) return jid.split('@')[0];
  
  // If it's NOT an @lid, the user part IS the phone number
  if (!jid.endsWith('@lid')) {
    return decoded.user; // e.g., "918949171377"
  }
  
  // For @lid, check cache
  const lidUser = decoded.user;
  if (lidPhoneCache.has(lidUser)) {
    return lidPhoneCache.get(lidUser);
  }
  
  // Return LID user as fallback
  return lidUser;
}

/**
 * Store LID to phone mapping (call this when we discover the mapping)
 * Implements LRU-style eviction when cache gets too large
 */
function storeLidPhoneMapping(lid, phone) {
  if (!lid || !phone) return;
  const decoded = jidDecode(lid);
  if (decoded && lid.endsWith('@lid')) {
    // LRU eviction: remove oldest entry if cache is full
    if (lidPhoneCache.size >= LID_CACHE_MAX_SIZE) {
      const oldestKey = lidPhoneCache.keys().next().value;
      lidPhoneCache.delete(oldestKey);
    }
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    lidPhoneCache.set(decoded.user, cleanPhone);
    logger.info(`[LID Cache] Mapped LID ${decoded.user} → Phone ${cleanPhone}`);
  }
}

// Memory thresholds - aggressive for low-RAM environments (512MB Render free tier)
const MEMORY_WARNING_THRESHOLD = 300 * 1024 * 1024; // 300MB
const MEMORY_CRITICAL_THRESHOLD = 420 * 1024 * 1024; // 420MB

// ============================================================================
// AUTH SCHEMA VERSION - INCREMENT ON BAILEYS KEY FORMAT CHANGES
// ============================================================================
const AUTH_VERSION = 4; // Simplified auth format

// ============================================================================
// INSTANCE ID - For logging and debugging
// ============================================================================
const os = require('os');
const crypto = require('crypto');
const INSTANCE_ID = `${os.hostname()}-${process.pid}-${Date.now()}`.slice(-20);
logger.info(`[Instance] ID: ${INSTANCE_ID}`);

// Connection locks - prevent concurrent connections to same account
const connectionLocks = new Map(); // accountId -> { timestamp, instanceId }

// ANTI-BAN: Duplicate message detection
// Prevents sending identical messages to same recipient in short period
const recentMessageHashes = new Map(); // key: `${accountId}:${jid}:${msgHash}` -> timestamp
const DUPLICATE_WINDOW_MS = 60000; // 60 seconds
const MAX_MESSAGE_HASHES = 10000; // Prevent unbounded growth

/**
 * Check if this is a duplicate message (same content to same recipient)
 * @returns {boolean} true if duplicate, false if allowed
 */
function isDuplicateMessage(accountId, jid, message) {
  const msgHash = crypto.createHash('sha256').update(message).digest('hex').slice(0, 16);
  const key = `${accountId}:${jid}:${msgHash}`;
  
  const lastSent = recentMessageHashes.get(key);
  if (lastSent && (Date.now() - lastSent) < DUPLICATE_WINDOW_MS) {
    return true; // Duplicate!
  }
  
  // Clean old entries if map gets too large
  if (recentMessageHashes.size >= MAX_MESSAGE_HASHES) {
    const now = Date.now();
    for (const [k, ts] of recentMessageHashes) {
      if (now - ts > DUPLICATE_WINDOW_MS) {
        recentMessageHashes.delete(k);
      }
    }
  }
  
  // Record this message
  recentMessageHashes.set(key, Date.now());
  return false;
}

/**
 * Generate stable per-account browser fingerprint
 * CRITICAL: Each account MUST have a unique fingerprint to avoid detection
 * WhatsApp flags multiple accounts using identical device signatures
 */
function getAccountBrowserFingerprint(accountId) {
  // Generate a deterministic but unique browser version per account
  // This simulates different Chrome installations on different machines
  const hash = crypto.createHash('sha256').update(accountId).digest('hex');
  
  // Use current Chrome version (update this quarterly!)
  // As of Jan 2026, Chrome is at version 131+
  const majorVersion = 131;
  const minorVersion = parseInt(hash.slice(0, 4), 16) % 100;
  
  // Vary the platform slightly based on hash
  const platforms = ['Windows', 'Windows 10', 'Windows 11'];
  const platformIndex = parseInt(hash.slice(4, 6), 16) % platforms.length;
  
  return [`Chrome (${platforms[platformIndex]})`, 'Chrome', `${majorVersion}.0.6778.${minorVersion}`];
}

// ============================================================================
// SIMPLIFIED AUTH STATE MANAGER - Based on Baileys useMultiFileAuthState
// ============================================================================
//
// KEY PRINCIPLE: Use Baileys' own useMultiFileAuthState for local files,
// then sync to database ONLY on connection.open and periodic intervals.
//
// This is the SAME pattern that works for millions of users.
// QR PHASE HANDLING:
//
// During QR scanning, local files are VOLATILE (not yet persisted to DB).
// If restartRequired (515) occurs during QR:
//   → DON'T wipe local files (they contain in-progress handshake)
//   → DON'T call restoreAuthFromDatabase (would clear volatile state)
//   → DO recreate socket using existing local files (skipRestore=true)
//
// Only after connection.open does local state become AUTHORITATIVE.
//
// ============================================================================

/**
 * SIMPLIFIED AUTH: Restore session from database to local files
 * Only called when starting a client that has saved auth
 */
async function restoreAuthFromDatabase(accountId) {
  const sessionPath = path.join('./wa-sessions-temp', accountId);
  
  // Check if local files exist and are recent (within last 5 minutes)
  // If so, prefer local files over database (prevents destroying in-progress QR handshake)
  const credsPath = path.join(sessionPath, 'creds.json');
  if (fs.existsSync(credsPath)) {
    try {
      const stats = fs.statSync(credsPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 300000) { // 5 minutes
        logger.info(`[Auth] Using recent local files for ${accountId} (${Math.round(ageMs/1000)}s old)`);
        return { restored: true, sessionPath };
      }
    } catch (e) {
      // Ignore stat errors
    }
  }
  
  // Ensure clean directory for restore
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionPath, { recursive: true });

  try {
    const sessionData = await db.getSessionData(accountId);
    
    if (!sessionData || sessionData.length < 100) {
      logger.info(`[Auth] No saved session for ${accountId}`);
      return { restored: false, sessionPath };
    }

    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(sessionData, 'base64').toString('utf-8'));
    } catch (e) {
      logger.error(`[Auth] Corrupted session for ${accountId}`);
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath };
    }

    // Version check
    if ((decoded.version || 1) < AUTH_VERSION) {
      logger.warn(`[Auth] Old auth version for ${accountId}, clearing`);
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath };
    }

    // Must have valid creds with me.id
    if (!decoded?.creds?.me?.id) {
      logger.warn(`[Auth] No me.id in session for ${accountId}`);
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath };
    }

    // Restore creds.json
    fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(decoded.creds, null, 2));

    // Restore all key files
    let keyCount = 0;
    if (decoded.keys && typeof decoded.keys === 'object') {
      for (const [filename, data] of Object.entries(decoded.keys)) {
        if (filename && data) {
          fs.writeFileSync(path.join(sessionPath, filename), JSON.stringify(data, null, 2));
          keyCount++;
        }
      }
    }

    logger.info(`[Auth] ✅ Restored ${accountId}: creds + ${keyCount} keys`);
    return { restored: true, sessionPath };

  } catch (err) {
    logger.error(`[Auth] Restore failed for ${accountId}: ${err.message}`);
    return { restored: false, sessionPath };
  }
}

/**
 * SIMPLIFIED AUTH: Save current session to database
 * Called after connection.open and periodically
 */
async function saveAuthToDatabase(accountId, sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    
    // Check existence asynchronously
    try {
      if (!fs.existsSync(credsPath)) return false;
    } catch { return false; }

    // Read creds (async to prevent blocking loop)
    const credsData = await fs.promises.readFile(credsPath, 'utf-8');
    const creds = JSON.parse(credsData);

    // Only save if we have valid auth (me.id present)
    if (!creds.me?.id) {
      logger.debug(`[Auth] Skip save - no me.id for ${accountId}`);
      return false;
    }

    // Collect all key files asynchronously
    const keys = {};
    const files = await fs.promises.readdir(sessionPath);
    
    // Process files in parallel
    const filePromises = files.map(async (file) => {
      if (file !== 'creds.json' && file.endsWith('.json')) {
        try {
          const content = await fs.promises.readFile(path.join(sessionPath, file), 'utf-8');
          keys[file] = JSON.parse(content);
        } catch {}
      }
    });
    
    await Promise.all(filePromises);

    const authBlob = {
      creds,
      keys,
      version: AUTH_VERSION,
      savedAt: new Date().toISOString()
    };

    const base64 = Buffer.from(JSON.stringify(authBlob)).toString('base64');
    await db.saveSessionData(accountId, base64);
    
    logger.info(`[Auth] ✅ Saved ${accountId}: ${Object.keys(keys).length} keys`);
    return true;

  } catch (err) {
    logger.error(`[Auth] Save failed for ${accountId}: ${err.message}`);
    return false;
  }
}

// ============================================================================
// ANTI-BAN: Message Rate Limiter (per account)
// ============================================================================
class AccountRateLimiter {
  constructor() {
    // Track message timestamps per account
    this.messageTimestamps = new Map(); // accountId -> [timestamps]
    this.lastMessageTime = new Map();   // accountId -> timestamp
    this.dailyMessageCount = new Map(); // accountId -> { date, count }
    
    // ANTI-BAN: Conservative limits to avoid detection
    // New accounts should start even slower!
    this.minIntervalMs = parseInt(process.env.WA_MIN_MESSAGE_INTERVAL_MS) || 5000; // 5s between messages (was 3s)
    this.maxMessagesPerHour = parseInt(process.env.WA_MAX_MESSAGES_PER_HOUR) || 60; // 60/hr (was 200)
    this.maxMessagesPerDay = parseInt(process.env.WA_MAX_MESSAGES_PER_DAY) || 500; // 500/day limit
    this.randomDelayMs = parseInt(process.env.WA_RANDOM_DELAY_MS) || 2000; // 0-2s random delay (was 1s)
    
    // Cleanup old timestamps every 10 minutes
    setInterval(() => this.cleanup(), 600000);
  }

  // Check if account can send a message, returns delay needed (0 = can send now)
  getRequiredDelay(accountId) {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    const lastTime = this.lastMessageTime.get(accountId) || 0;
    const elapsed = now - lastTime;
    
    // Check minimum interval between messages
    if (elapsed < this.minIntervalMs) {
      return this.minIntervalMs - elapsed + Math.random() * this.randomDelayMs;
    }
    
    // ANTI-BAN: Check daily limit first (most important)
    const dailyData = this.dailyMessageCount.get(accountId) || { date: today, count: 0 };
    if (dailyData.date !== today) {
      // Reset for new day
      dailyData.date = today;
      dailyData.count = 0;
    }
    
    if (dailyData.count >= this.maxMessagesPerDay) {
      logger.warn(`[RateLimit] Account ${accountId} hit DAILY limit (${this.maxMessagesPerDay}) - BLOCKED until tomorrow`);
      // Calculate time until midnight
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      return midnight.getTime() - now;
    }
    
    // Check hourly limit
    const timestamps = this.messageTimestamps.get(accountId) || [];
    const oneHourAgo = now - 3600000;
    const recentCount = timestamps.filter(t => t > oneHourAgo).length;
    
    if (recentCount >= this.maxMessagesPerHour) {
      logger.warn(`[RateLimit] Account ${accountId} hit hourly limit (${this.maxMessagesPerHour})`);
      return 60000; // Wait 1 minute
    }
    
    return 0;
  }

  // Record a sent message
  recordMessage(accountId) {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    
    this.lastMessageTime.set(accountId, now);
    
    const timestamps = this.messageTimestamps.get(accountId) || [];
    timestamps.push(now);
    this.messageTimestamps.set(accountId, timestamps);
    
    // Track daily count
    const dailyData = this.dailyMessageCount.get(accountId) || { date: today, count: 0 };
    if (dailyData.date !== today) {
      dailyData.date = today;
      dailyData.count = 0;
    }
    dailyData.count++;
    this.dailyMessageCount.set(accountId, dailyData);
    
    logger.debug(`[RateLimit] ${accountId}: ${dailyData.count}/${this.maxMessagesPerDay} daily, ${timestamps.filter(t => t > now - 3600000).length}/${this.maxMessagesPerHour} hourly`);
  }

  // Wait with random jitter (anti-pattern detection)
  async waitWithJitter(accountId) {
    const delay = this.getRequiredDelay(accountId);
    if (delay > 0) {
      const jitter = Math.floor(Math.random() * this.randomDelayMs);
      logger.debug(`[RateLimit] Account ${accountId} waiting ${delay + jitter}ms`);
      await new Promise(resolve => setTimeout(resolve, delay + jitter));
    }
  }

  cleanup() {
    const oneHourAgo = Date.now() - 3600000;
    for (const [accountId, timestamps] of this.messageTimestamps) {
      const filtered = timestamps.filter(t => t > oneHourAgo);
      if (filtered.length === 0) {
        this.messageTimestamps.delete(accountId);
      } else {
        this.messageTimestamps.set(accountId, filtered);
      }
    }
  }
}

const rateLimiter = new AccountRateLimiter();

// Global message store for retry support (in-memory cache + database persistence)
// In-memory acts as L1 cache, database is persistent L2 storage
// Key: messageId, Value: { message, timestamp, accountId }
const globalMessageStore = new Map();
const MESSAGE_STORE_MAX_SIZE = 1000;
const MESSAGE_STORE_TTL = 10 * 60 * 1000; // 10 minutes in-memory

// Cleanup old messages periodically (in-memory + database)
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of globalMessageStore) {
    if (now - data.timestamp > MESSAGE_STORE_TTL) {
      globalMessageStore.delete(id);
    }
  }
}, 60000);

// Cleanup old database messages every hour
setInterval(async () => {
  try {
    await db.cleanupOldMessages();
  } catch (e) {
    logger.warn(`[MsgStore] DB cleanup error: ${e.message}`);
  }
}, 60 * 60 * 1000);

class WhatsAppManager {
  constructor() {
    this.clients = new Map();       // accountId -> socket
    this.qrCodes = new Map();       // accountId -> qr data URL
    this.accountStatus = new Map(); // accountId -> status string
    this.reconnecting = new Set();
    this.deletedAccounts = new Set(); // Track deleted accounts to prevent QR regeneration
    this.qrAttempts = new Map();
    this.reconnectAttempts = new Map(); // accountId -> { count, lastAttempt }
    this.isShuttingDown = false;
    this.io = null;
    this.authStates = new Map();    // accountId -> { sessionPath, saveCreds }

    // Minimal metrics
    this.metrics = {
      messagesProcessed: 0,
      messagesFailed: 0,
      webhooksDelivered: 0,
      webhooksFailed: 0
    };

    // Memory monitoring (every 60 seconds)
    setInterval(() => this.checkMemoryUsage(), 60000);

    // Cleanup disconnected accounts (every 5 minutes)
    setInterval(() => this.cleanupDisconnectedAccounts(), 300000);

    // Refresh presence for all accounts (every 30-60 minutes) - ANTI-BAN: was 15 min
    // Stagger each account to avoid synchronized patterns
    setInterval(() => this.refreshAllPresenceStaggered(), 1800000 + Math.random() * 1800000);
    
    // Periodic database sync for connected accounts (every 5 minutes)
    // This ensures auth is always saved in case of crashes
    setInterval(() => this.periodicAuthSync(), 300000);
  }
  
  // Periodic sync of auth to database for all connected accounts
  async periodicAuthSync() {
    for (const [accountId, authState] of this.authStates.entries()) {
      if (this.accountStatus.get(accountId) === 'ready' && authState?.sessionPath) {
        try {
          await saveAuthToDatabase(accountId, authState.sessionPath);
          logger.debug(`[Auth] Periodic sync for ${accountId}`);
        } catch (e) {
          logger.warn(`[Auth] Periodic sync failed for ${accountId}: ${e.message}`);
        }
      }
    }
  }

  // Refresh presence for all connected accounts to maintain delivery receipt capability
  // ANTI-BAN: Stagger each account by random delay to avoid synchronized patterns
  async refreshAllPresenceStaggered() {
    for (const [accountId, sock] of this.clients) {
      if (this.accountStatus.get(accountId) === 'ready' && sock) {
        // Stagger each account by 0-5 minutes
        const staggerMs = Math.random() * 300000;
        setTimeout(async () => {
          try {
            if (this.accountStatus.get(accountId) === 'ready') {
              await sock.sendPresenceUpdate('available');
              logger.debug(`[${accountId}] Presence refreshed to 'available'`);
            }
          } catch (e) {
            // Ignore errors - connection may be temporarily unstable
          }
        }, staggerMs);
      }
    }
  }

  // Legacy method for backwards compatibility
  async refreshAllPresence() {
    return this.refreshAllPresenceStaggered();
  }

  setSocketIO(io) {
    this.io = io;
    logger.info('Socket.IO instance set for WhatsAppManager');
  }

  emitToAll(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  emitToAccount(accountId, event, data) {
    if (this.io) {
      this.io.to(`account-${accountId}`).emit(event, data);
    }
  }

  checkMemoryUsage() {
    const used = process.memoryUsage();
    const rss = used.rss;

    if (rss > MEMORY_CRITICAL_THRESHOLD) {
      logger.warn(`⚠️ CRITICAL: Memory ${Math.round(rss / 1024 / 1024)}MB - forcing GC`);
      if (global.gc) {
        global.gc();
      }
    } else if (rss > MEMORY_WARNING_THRESHOLD) {
      logger.info(`Memory: ${Math.round(rss / 1024 / 1024)}MB`);
    }
  }

  async safeDisposeClient(accountId, timeoutMs = 15000) {
    const client = this.clients.get(accountId);
    if (!client) return true;

    try {
      // Close WebSocket connection
      client.end(undefined);
      logger.info(`Client disposed for ${accountId}`);
    } catch (error) {
      logger.warn(`Error disposing client ${accountId}:`, error.message);
    } finally {
      this.clients.delete(accountId);
      this.qrCodes.delete(accountId);
      this.authStates.delete(accountId);
      // Release connection lock
      connectionLocks.delete(accountId);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    return true;
  }

  async createAccount(accountName, description = '') {
    if (this.isShuttingDown) {
      throw new Error('Server is shutting down');
    }

    const accountId = uuidv4();

    try {
      const accountData = {
        id: accountId,
        name: accountName,
        description: description,
        status: 'initializing',
        created_at: new Date().toISOString(),
        metadata: { created_by: 'system', version: '4.0', auth: 'baileys' }
      };

      const account = await db.createAccount(accountData);

      // Start connection
      await this.startBaileysClient(accountId);

      logger.info(`Account created: ${accountId} (${accountName})`);
      return account;
    } catch (error) {
      logger.error('Error creating account:', error);
      this.accountStatus.set(accountId, 'error');
      throw error;
    }
  }

  async startBaileysClient(accountId, skipRestore = false) {
    // Don't start client for deleted accounts
    if (this.deletedAccounts.has(accountId)) {
      logger.info(`Skipping client start - account ${accountId} was deleted`);
      return null;
    }

    // ANTI-BAN: Check connection lock to prevent duplicate connections
    const existingLock = connectionLocks.get(accountId);
    if (existingLock && existingLock.instanceId !== INSTANCE_ID) {
      const lockAge = Date.now() - existingLock.timestamp;
      // Lock expires after 15 minutes (in case instance crashed)
      // Extended from 5 min to 15 min to prevent dual-connection detection
      if (lockAge < 900000) {
        logger.warn(`[Auth] Account ${accountId} locked by another instance (${existingLock.instanceId}). Waiting...`);
        throw new Error('Account is connected from another instance');
      }
    }
    
    // Acquire lock
    connectionLocks.set(accountId, { timestamp: Date.now(), instanceId: INSTANCE_ID });

    const sessionPath = path.join('./wa-sessions-temp', accountId);

    try {
      // STEP 1: Restore auth from database (unless skipRestore=true for QR cycling)
      if (!skipRestore) {
        const restoreResult = await restoreAuthFromDatabase(accountId);
        if (!restoreResult.restored) {
          logger.info(`[Auth] Account ${accountId} needs QR scan`);
          this.accountStatus.set(accountId, 'needs_qr');
        }
      }

      // STEP 2: Use Baileys' official useMultiFileAuthState (proven, battle-tested)
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      
      // Store for periodic DB saves
      this.authStates.set(accountId, { sessionPath, saveCreds });

      const { version } = await fetchLatestBaileysVersion();
      logger.info(`Using Baileys version: ${version.join('.')}`);

      // Per-account stable browser fingerprint
      const browserFingerprint = getAccountBrowserFingerprint(accountId);
      logger.debug(`[Auth] Browser fingerprint for ${accountId}: ${browserFingerprint.join('/')}`);

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: browserFingerprint,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: true,
        // Anti-ban: Don't mark online immediately to avoid "bot-like" activity spikes
        markOnlineOnConnect: false, 
        fireInitQueries: true,       // Added: Ensures proper handshake with WhatsApp
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        // Message retry configuration - fixes "Waiting for this message" issue
        // CRITICAL: Use NodeCache for retry counter (tracks retry attempts, not messages!)
        msgRetryCounterCache: msgRetryCounterCache,
        // Anti-ban: Increased delay to prevent rapid-fire retry loops
        retryRequestDelayMs: 350, // Match Evolution API's setting
        maxMsgRetryCount: 4,      // Match Evolution API's setting
        getMessage: async (key) => {
          // CRITICAL: This is called by Baileys when WhatsApp requests a message resend
          // If we don't return the message, the receiver sees "Waiting for this message"
          logger.info(`[getMessage] ⚡ Retry requested for message ${key.id?.slice(0, 20)}... remoteJid: ${key.remoteJid?.slice(0, 20)}`);
          
          // L1: Check in-memory cache first (fastest)
          if (globalMessageStore.has(key.id)) {
            const stored = globalMessageStore.get(key.id);
            logger.info(`[getMessage] ✅ Found message ${key.id?.slice(0, 15)}... in MEMORY cache`);
            return stored.message;
          }
          
          // L2: Fall back to database (persists across restarts)
          try {
            const dbMessage = await db.getMessage(accountId, key.id);
            if (dbMessage) {
              logger.info(`[getMessage] ✅ Found message ${key.id?.slice(0, 15)}... in DATABASE`);
              // Re-populate memory cache for future fast access
              globalMessageStore.set(key.id, {
                message: dbMessage,
                timestamp: Date.now(),
                accountId
              });
              return dbMessage;
            }
          } catch (e) {
            logger.warn(`[getMessage] DB lookup failed: ${e.message}`);
          }
          
          // Message not found - THIS CAUSES "Waiting for this message"
          logger.error(`[getMessage] ❌ Message ${key.id?.slice(0, 20)}... NOT FOUND for retry - receiver will see "Waiting for this message"`);
          return undefined;
        }
      });

      this.clients.set(accountId, sock);
      this.accountStatus.set(accountId, 'initializing');

      // Setup event handlers
      this.setupBaileysEventHandlers(sock, accountId, saveCreds);

      return sock;
    } catch (error) {
      logger.error(`Error starting Baileys client for ${accountId}:`, error);
      this.accountStatus.set(accountId, 'error');
      throw error;
    }
  }

  setupBaileysEventHandlers(sock, accountId, saveCreds) {
    // Connection update (QR code, connection state)
    sock.ev.on('connection.update', async (update) => {
      // Skip all events if account was deleted
      if (this.deletedAccounts.has(accountId)) {
        logger.info(`Ignoring connection event for deleted account ${accountId}`);
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      // QR Code received
      if (qr) {
        // Double-check account wasn't deleted before generating QR
        if (this.deletedAccounts.has(accountId)) {
          logger.info(`Skipping QR generation - account ${accountId} was deleted`);
          return;
        }
        
        // ANTI-BAN: Rate limit QR generation (max 1 every 30 seconds)
        const lastQrTime = this.qrAttempts.get(accountId) || 0;
        const qrCooldown = 30000; // 30 seconds
        if (Date.now() - lastQrTime < qrCooldown) {
          logger.warn(`[QR] Rate limited for ${accountId} - too many QR requests`);
          return;
        }
        this.qrAttempts.set(accountId, Date.now());
        
        try {
          const qrDataUrl = await qrcode.toDataURL(qr);
          this.qrCodes.set(accountId, qrDataUrl);

          await db.updateAccount(accountId, {
            status: 'qr_ready',
            qr_code: qrDataUrl,
            updated_at: new Date().toISOString()
          });

          this.accountStatus.set(accountId, 'qr_ready');
          this.emitToAll('qr', { accountId, qr: qrDataUrl });

          logger.info(`QR generated for ${accountId}`);
        } catch (error) {
          logger.error(`QR error for ${accountId}:`, error);
        }
      }

      // Connection opened
      if (connection === 'open') {
        const phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || 'unknown';
        const userJid = sock.user?.id;

        // Fetch profile picture URL
        let profilePictureUrl = null;
        if (userJid) {
          try {
            profilePictureUrl = await sock.profilePictureUrl(userJid, 'image');
            logger.info(`[${accountId}] Profile picture fetched`);
          } catch (e) {
            logger.debug(`[${accountId}] No profile picture available`);
          }
        }

        await db.updateAccount(accountId, {
          status: 'ready',
          phone_number: phoneNumber,
          metadata: { profile_picture_url: profilePictureUrl },
          last_active_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        this.accountStatus.set(accountId, 'ready');
        this.qrCodes.delete(accountId);
        this.reconnecting.delete(accountId);
        this.reconnectAttempts.delete(accountId);

        // =====================================================================
        // STABILIZATION SAVE TO DATABASE - Critical for crash recovery
        // =====================================================================
        // Wait a moment for Signal keys to stabilize, then save to DB
        setTimeout(async () => {
          try {
            const authState = this.authStates.get(accountId);
            if (authState?.sessionPath) {
              await saveAuthToDatabase(accountId, authState.sessionPath);
              logger.info(`[Auth] ✅ Saved to database for ${accountId}`);
            }
          } catch (e) {
            logger.error(`[Auth] DB save failed: ${e.message}`);
          }
        }, 5000); // Wait 5 seconds for keys to stabilize

        // ANTI-BAN: Don't immediately set presence to 'available'
        // Let it happen naturally after 30-60 seconds (more human-like)
        // Immediate online status after connect is a bot indicator
        const presenceDelay = 30000 + Math.random() * 30000; // 30-60 seconds
        setTimeout(async () => {
          try {
            if (this.accountStatus.get(accountId) === 'ready') {
              await sock.sendPresenceUpdate('available');
              logger.info(`[${accountId}] Presence set to 'available' (delayed)`);
            }
          } catch (e) {
            logger.warn(`[${accountId}] Failed to set presence: ${e.message}`);
          }
        }, presenceDelay);

        this.emitToAll('ready', { accountId, phoneNumber });
        logger.info(`✅ WhatsApp ready for ${accountId} (${phoneNumber})`);
      }

      // Connection closed
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || lastDisconnect?.error?.message || 'unknown';

        logger.warn(`Disconnected ${accountId}: ${reason} (code: ${statusCode})`);

        // Handle different disconnect reasons
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        // Special handling for connectionReplaced (440) - another device connected
        const isConnectionReplaced = statusCode === 440 || statusCode === DisconnectReason.connectionReplaced;
        
        // Special handling for restartRequired (515) - QR timeout or protocol restart
        const isRestartRequired = statusCode === 515 || statusCode === DisconnectReason.restartRequired;

        // Special handling for "Connection Closed" (428) - Precondition Required
        // This often happens due to network flakiness or server-side closure
        const isConnectionClosed = statusCode === 428;

        if (statusCode === DisconnectReason.loggedOut) {
          // User logged out - MUST clear all auth data
          logger.warn(`[Auth] Account ${accountId} logged out - clearing all auth`);
          
          // Clear database auth
          await db.clearSessionData(accountId);
          
          // Clear local files
          const sessionPath = path.join('./wa-sessions-temp', accountId);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          
          await db.updateAccount(accountId, {
            status: 'disconnected', // Changed from 'logged_out' to match SQL constraint
            error_message: 'Logged out - QR scan required',
            updated_at: new Date().toISOString()
          });
          this.accountStatus.set(accountId, 'disconnected'); // Match SQL status
          this.clients.delete(accountId);
          this.authStates.delete(accountId);
          this.reconnectAttempts.delete(accountId);
        } else if (isConnectionReplaced) {
          // connectionReplaced - another instance/device took over
          const attempts = this.reconnectAttempts.get(accountId) || { count: 0, lastAttempt: 0 };
          const now = Date.now();
          
          // ANTI-BAN: Track over 1 hour window (was 5 minutes)
          if (now - attempts.lastAttempt > 3600000) {
            attempts.count = 0;
          }
          
          attempts.count++;
          attempts.lastAttempt = now;
          this.reconnectAttempts.set(accountId, attempts);
          
          const backoffMs = Math.min(30000 * Math.pow(2, attempts.count - 1), 600000); // 30s, 60s, 120s, max 10min
          
          // ANTI-BAN: Only allow 2 attempts per hour (was 3 per 5 min)
          if (attempts.count >= 2) {
            logger.error(`Connection replaced ${attempts.count} times for ${accountId} - STOPPING to prevent ban`);
            logger.error(`Close WhatsApp on other devices and wait 1 hour before reconnecting`);
            await db.updateAccount(accountId, {
              status: 'disconnected',
              error_message: 'Connection replaced multiple times - close WhatsApp on other devices and try again in 1 hour',
              updated_at: new Date().toISOString()
            }).catch(() => {});
            this.accountStatus.set(accountId, 'disconnected');
            this.clients.delete(accountId);
          } else {
            logger.info(`Connection replaced for ${accountId}. Waiting ${backoffMs/1000}s...`);
            this.accountStatus.set(accountId, 'reconnecting');
            
            setTimeout(async () => {
              if (!this.isShuttingDown && !this.deletedAccounts.has(accountId)) {
                try {
                  await this.startBaileysClient(accountId);
                } catch (err) {
                  logger.error(`Reconnect failed for ${accountId}:`, err.message);
                }
              }
            }, backoffMs);
          }
        } else if (isRestartRequired || isConnectionClosed) {
          // restartRequired (515) - Normal during QR scanning
          // Connection Closed (428) - Retryable error
          // Don't wipe local files - they contain in-progress handshake
          const currentStatus = this.accountStatus.get(accountId);
          const isQrPhase = currentStatus === 'qr_ready' || currentStatus === 'needs_qr';
          
          const reasonType = isConnectionClosed ? 'Connection Closed (428)' : 'Restart Required (515)';
          logger.info(`[Reconnect] ${reasonType} for ${accountId} (QR phase: ${isQrPhase})`);
          
          if (!isQrPhase) {
            this.accountStatus.set(accountId, 'reconnecting');
          }
          
          // ANTI-BAN: Use longer delays with jitter to avoid pattern detection
          const baseDelay = 15000; // 15 seconds base
          const jitter = Math.floor(Math.random() * 15000); // 0-15s random
          const reconnectDelay = baseDelay + jitter;
          
          logger.info(`[Reconnect] Will retry ${accountId} in ${Math.round(reconnectDelay/1000)}s...`);
          
          setTimeout(async () => {
            if (!this.isShuttingDown && !this.deletedAccounts.has(accountId)) {
              // If it was a 428 error, we definitely want to try reconnecting
              const shouldRetry = isConnectionClosed || this.accountStatus.get(accountId) !== 'ready';
              
              if (shouldRetry) {
                logger.info(`[Reconnect] Retrying connection for ${accountId}...`);
                try {
                  // skipRestore=true preserves local handshake files
                  // IMPORTANT: For 428 errors, we might want to skip restore to keep session state
                  await this.startBaileysClient(accountId, true);
                } catch (err) {
                  logger.error(`[Reconnect] Failed for ${accountId}:`, err.message);
                  this.accountStatus.set(accountId, 'disconnected');
                }
              }
            }
          }, reconnectDelay);
        } else if (shouldReconnect && !this.isShuttingDown) {
          // Normal disconnect - reconnect after delay
          this.accountStatus.set(accountId, 'reconnecting');
          this.reconnectAttempts.delete(accountId);
          
          // ANTI-BAN: Longer delay with jitter for normal disconnects
          const normalDelay = 10000 + Math.floor(Math.random() * 10000); // 10-20s
          logger.info(`[Reconnect] Will reconnect ${accountId} in ${Math.round(normalDelay/1000)}s...`);
          
          setTimeout(async () => {
            if (!this.isShuttingDown && !this.reconnecting.has(accountId) && !this.deletedAccounts.has(accountId)) {
              logger.info(`Reconnecting ${accountId}...`);
              try {
                await this.startBaileysClient(accountId);
              } catch (err) {
                logger.error(`Reconnect failed for ${accountId}:`, err.message);
                this.accountStatus.set(accountId, 'disconnected');
              }
            }
          }, normalDelay);
        } else {
          await db.updateAccount(accountId, {
            status: 'disconnected',
            error_message: reason,
            updated_at: new Date().toISOString()
          });
          this.accountStatus.set(accountId, 'disconnected');
        }

        this.emitToAll('disconnected', { accountId, reason });
      }
    });

    // Credentials updated - save to LOCAL file only (atomic keys already persisted)
    // database sync happens on connection.open stabilization and periodic saves
    sock.ev.on('creds.update', saveCreds);

    // History sync - log only, no special handling needed
    // Keys are saved atomically as they're created
    sock.ev.on('messaging-history.set', async () => {
      logger.debug(`[Auth] History sync received for ${accountId}`);
      // Keys are saved automatically by useMultiFileAuthState
    });
    
    // Contacts update - capture LID to phone number mappings
    sock.ev.on('contacts.update', async (contacts) => {
      for (const contact of contacts) {
        // If contact has both lid and phoneNumber, store the mapping
        if (contact.id && contact.phoneNumber) {
          storeLidPhoneMapping(contact.id, contact.phoneNumber);
        }
        // Also check if id is LID and there's a linked PN
        if (contact.lid && contact.id) {
          // contact.id might be the phone number format
          if (!contact.id.endsWith('@lid')) {
            storeLidPhoneMapping(contact.lid, contact.id.split('@')[0]);
          }
        }
      }
    });
    
    // Contacts upsert - same as update
    sock.ev.on('contacts.upsert', async (contacts) => {
      for (const contact of contacts) {
        if (contact.id && contact.phoneNumber) {
          storeLidPhoneMapping(contact.id, contact.phoneNumber);
        }
        if (contact.lid && contact.id && !contact.id.endsWith('@lid')) {
          storeLidPhoneMapping(contact.lid, contact.id.split('@')[0]);
        }
      }
    });

    // Incoming messages - handle without triggering mid-decrypt saves
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          // CRITICAL FIX: Store ALL incoming messages for retry support
          // This fixes "Waiting for this message" when replying to received messages
          if (message.key?.id && message.message) {
            // L1: Store in memory (fast access)
            if (globalMessageStore.size >= MESSAGE_STORE_MAX_SIZE) {
              const oldestKey = globalMessageStore.keys().next().value;
              globalMessageStore.delete(oldestKey);
            }
            globalMessageStore.set(message.key.id, {
              message: message.message,
              timestamp: Date.now(),
              accountId
            });
            
            // L2: Persist to database (survives restarts)
            // Fire and forget - don't block message handling
            db.storeMessage(accountId, message.key.id, message.message, 'in', message.key.remoteJid)
              .catch(e => logger.debug(`[MsgStore] Async DB store failed: ${e.message}`));
            
            logger.info(`[MsgStore] ✅ Stored incoming message ${message.key.id?.slice(0, 15)}... from ${message.key.remoteJid?.slice(0, 15)}`);
          }
          
          await this.handleIncomingMessage(sock, accountId, message);
        } catch (error) {
          logger.error(`Message handler error for ${accountId}:`, error);
        }
      }
      // Note: Auth saves are handled by creds.update which is already gated
    });

    // Message status updates (sent, delivered, read)
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        try {
          if (update.update?.status) {
            const statusNames = { 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read' };
            const statusName = statusNames[update.update.status] || 'unknown';

            if (update.update.status >= 3) {
              const msgData = {
                event: 'message_ack',
                account_id: accountId,
                message_id: update.key.id,
                recipient: update.key.remoteJid,
                ack: update.update.status,
                ack_name: statusName,
                timestamp: Date.now(),
                created_at: new Date().toISOString()
              };

              await this.queueWebhookDeliveries(accountId, msgData);
              logger.info(`📬 Message ${statusName}: ${update.key.id?.slice(0, 20)}...`);
            }
          }
        } catch (error) {
          logger.warn('Message update handler error:', error.message);
        }
      }
    });

    // Handle message receipt updates (delivery/read confirmations)
    sock.ev.on('message-receipt.update', async (receipts) => {
      for (const receipt of receipts) {
        try {
          const receiptType = receipt.receipt?.receiptTimestamp ? 'delivered' : 
                             receipt.receipt?.readTimestamp ? 'read' : 'unknown';
          logger.debug(`📨 Receipt update for ${receipt.key?.id?.slice(0, 15)}...: ${receiptType}`);
        } catch (error) {
          logger.warn('Message receipt handler error:', error.message);
        }
      }
    });
  }

  async handleIncomingMessage(sock, accountId, message) {
    // Ignore status broadcasts and own messages
    if (message.key.remoteJid === 'status@broadcast') return;
    if (message.key.fromMe) return;

    try {
      const messageContent = message.message;
      if (!messageContent) return;

      // Extract message text
      let messageText = '';
      let interactiveReply = null;

      if (messageContent.conversation) {
        messageText = messageContent.conversation;
      } else if (messageContent.extendedTextMessage?.text) {
        messageText = messageContent.extendedTextMessage.text;
      } else if (messageContent.imageMessage?.caption) {
        messageText = messageContent.imageMessage.caption;
      } else if (messageContent.videoMessage?.caption) {
        messageText = messageContent.videoMessage.caption;
      } else if (messageContent.interactiveResponseMessage) {
        // Handle button/list replies
        const irm = messageContent.interactiveResponseMessage;
        if (irm.nativeFlowResponseMessage?.paramsJson) {
          try {
            const params = JSON.parse(irm.nativeFlowResponseMessage.paramsJson);
            // Button reply: { id: 'btn_xxx', display_text: 'Yes' }
            // List reply: { id: 'row_xxx', title: 'Option 1' }
            interactiveReply = {
              type: params.id?.startsWith('row_') ? 'list_reply' : 'button_reply',
              id: params.id,
              title: params.display_text || params.title || '',
              params
            };
            // Use the display text as message text for chatbot processing
            messageText = params.display_text || params.title || params.id || '';
            logger.info(`📲 Interactive reply: ${interactiveReply.type} - "${messageText}" (id: ${params.id})`);
          } catch (e) {
            logger.warn(`Failed to parse interactive response: ${e.message}`);
          }
        }
      }

      // Get sender info - prefer senderPn (actual phone) over remoteJid (could be @lid)
      const senderJid = message.key.participant || message.key.remoteJid;
      const chatJid = message.key.remoteJid;
      
      // Extract actual phone number from senderPn field (contains real phone for @lid contacts)
      // Format: "918005780278@s.whatsapp.net" -> "918005780278"
      let senderPhone;
      if (message.key.senderPn) {
        // senderPn contains the real phone number!
        senderPhone = message.key.senderPn.split('@')[0];
        // Cache the LID to phone mapping for future use
        if (chatJid.endsWith('@lid')) {
          storeLidPhoneMapping(chatJid, senderPhone);
        }
      } else {
        senderPhone = getPhoneNumber(senderJid);
      }
      
      // For chat_id, use cached phone if available
      const chatPhone = getPhoneNumber(chatJid);
      
      // Log with actual phone number
      logger.info(`📩 Incoming message from ${senderPhone}: "${messageText?.slice(0, 50) || '[media]'}"`);

      // Determine message type
      let messageType = 'text';
      if (messageContent.imageMessage) messageType = 'image';
      else if (messageContent.videoMessage) messageType = 'video';
      else if (messageContent.audioMessage) messageType = 'audio';
      else if (messageContent.documentMessage) messageType = 'document';
      else if (messageContent.stickerMessage) messageType = 'sticker';
      else if (messageContent.contactMessage) messageType = 'contact';
      else if (messageContent.locationMessage) messageType = 'location';
      else if (messageContent.interactiveResponseMessage) messageType = 'interactive_reply';

      const isGroup = chatJid.endsWith('@g.us');

      const messageData = {
        event: 'message',  // Event type for webhook filtering
        account_id: accountId,
        direction: 'incoming',
        message_id: message.key.id,
        sender: senderPhone,  // Phone number with country code
        recipient: chatPhone,  // Phone number with country code
        message: messageText,
        timestamp: message.messageTimestamp,
        type: messageType,
        chat_id: chatPhone,  // Phone number for consistent lookups
        is_group: isGroup,
        group_name: null,
        status: 'success',
        interactive_reply: interactiveReply, // Button/list reply data (null if not interactive)
        created_at: new Date().toISOString()
      };

      // Update last active (don't crash on DB error)
      db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      }).catch(err => {
        logger.warn(`Failed to update last_active_at: ${err.message}`);
      });

      // Queue webhook deliveries
      this.queueWebhookDeliveries(accountId, messageData).catch(err => {
        logger.error(`Webhook queue error:`, err);
      });

      // Process through chatbot (if enabled for this account)
      if (messageText && !isGroup) {
        try {
          logger.info(`[Chatbot] Processing message for account ${accountId}...`);
          const aiResponse = await chatbotManager.processMessage(accountId, {
            body: messageText,
            from: senderPhone,  // Use phone number for chatbot context
            getChat: async () => ({})
          }, chatPhone);  // Use phone number for history lookup

          if (aiResponse) {
            logger.info(`[Chatbot] AI generated response: "${aiResponse.slice(0, 100)}..."`);
            
            // Use the original JID for sending (Baileys needs exact format)
            const replyJid = chatJid;
            
            try {
              // ANTI-BAN: Apply rate limiting to chatbot responses too!
              await rateLimiter.waitWithJitter(accountId);
              
              logger.info(`[Chatbot] Sending response to ${chatPhone}...`);
              
              // Send directly using sock.sendMessage with the exact JID
              const sock = this.clients.get(accountId);
              if (sock) {
                // ANTI-BAN: Calculate typing time based on response length
                // Average human types ~200 chars/min = 3.3 chars/sec
                const typingTime = Math.min(8000, Math.max(1500, (aiResponse.length / 3.3) * 1000));
                const typingJitter = Math.random() * 1500;
                
                // Show typing
                try {
                  await sock.presenceSubscribe(replyJid);
                  await sock.sendPresenceUpdate('composing', replyJid);
                  await new Promise(resolve => setTimeout(resolve, typingTime + typingJitter));
                  await sock.sendPresenceUpdate('paused', replyJid);
                } catch {}
                
                const result = await sock.sendMessage(replyJid, { text: aiResponse });
                
                // ANTI-BAN: Record message for rate limiting
                rateLimiter.recordMessage(accountId);
                
                logger.info(`[Chatbot] ✅ Response sent to ${chatPhone} (msgId: ${result?.key?.id?.slice(0, 10)}...)`);
              }
            } catch (sendError) {
              logger.error(`[Chatbot] ❌ Failed to send response: ${sendError.message}`);
            }
          }
        } catch (chatbotError) {
          logger.error(`[Chatbot] Error processing message:`, chatbotError);
        }
      }

      this.metrics.messagesProcessed++;
      // Note: Session keys are saved via creds.update event when they change
    } catch (error) {
      logger.error(`Incoming message error:`, error);
      this.metrics.messagesFailed++;
    }
  }

  async queueWebhookDeliveries(accountId, messageData) {
    try {
      const webhooks = await db.getWebhooks(accountId);
      const activeWebhooks = (webhooks || []).filter(w => w.is_active);

      if (activeWebhooks.length > 0) {
        await webhookDeliveryService.queueDeliveries(accountId, activeWebhooks, messageData);
      }
    } catch (error) {
      logger.error(`Webhook delivery error:`, error);
    }
  }

  formatPhoneNumber(number) {
    if (number.includes('@')) return number;

    let cleaned = number.replace(/[^\d]/g, '').replace(/^0+/, '');

    if (cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }

    return cleaned + '@s.whatsapp.net';
  }

  async sendMessage(accountId, number, message, options = {}) {
    // PRE-CHECK: Fail fast if account doesn't exist
    if (!this.clients.has(accountId)) throw new Error('Client not found');

    const jid = this.formatPhoneNumber(number);

    // ANTI-BAN: Check for duplicate message (same content to same recipient within 60s)
    if (isDuplicateMessage(accountId, jid, message)) {
      logger.warn(`[Anti-Ban] Blocked duplicate message to ${jid.split('@')[0]} within 60s window`);
      throw new Error('Duplicate message blocked - same content sent to this recipient within 60 seconds');
    }

    try {
      // Anti-ban: Wait for rate limit with jitter
      await rateLimiter.waitWithJitter(accountId);

      // CRITICAL FIX: Retreive socket specifically AFTER the wait
      // A reconnection might have happened during the delay
      let sock = this.clients.get(accountId);
      let status = this.accountStatus.get(accountId);

      if (!sock || status !== 'ready') {
        throw new Error(`Client not ready after wait: ${status}`);
      }

      // Show typing indicator (human-like behavior)
      // ANTI-BAN: Calculate typing time based on message length
      // Average human types ~200 chars/min = 3.3 chars/sec
      const charsPerSecond = 3.3;
      const minTypingMs = 1500;
      const maxTypingMs = 8000;
      const baseTyping = Math.min(maxTypingMs, Math.max(minTypingMs, (message.length / charsPerSecond) * 1000));
      const typingJitter = Math.random() * 2000; // 0-2s random
      
      if (baseTyping > 0) {
        try {
          await sock.presenceSubscribe(jid);
          await sock.sendPresenceUpdate('composing', jid);
          await new Promise(resolve => setTimeout(resolve, baseTyping + typingJitter));
          await sock.sendPresenceUpdate('paused', jid);
        } catch (e) { /* ignore presence errors */ }
      }

      // Re-fetch socket one last time before critical send
      sock = this.clients.get(accountId);
      if (!sock) throw new Error('Client lost connection during typing delay');

      // Create message content
      const msgContent = { text: message };
      
      const result = await sock.sendMessage(jid, msgContent);

      // Log successful send
      logger.info(`📤 Message sent to ${jid.split('@')[0]} - ID: ${result?.key?.id?.slice(0, 15)}...`);

      // Record message for rate limiting
      rateLimiter.recordMessage(accountId);

      // Store message in global store for retry support (prevents "Waiting for this message")
      // CRITICAL: Store result.message (the actual proto.IMessage), NOT msgContent (the input)
      // Baileys getMessage callback expects the proto.IMessage format
      if (result?.key?.id && result.message) {
        // L1: Store in memory (fast access)
        if (globalMessageStore.size >= MESSAGE_STORE_MAX_SIZE) {
          const oldestKey = globalMessageStore.keys().next().value;
          globalMessageStore.delete(oldestKey);
        }
        globalMessageStore.set(result.key.id, {
          message: result.message,  // FIXED: Store proto.IMessage, not input
          timestamp: Date.now(),
          accountId
        });
        
        logger.info(`[MsgStore] ✅ Stored outgoing message ${result.key.id?.slice(0, 15)}... for retry support`);
        
        // L2: Persist to database (survives restarts)
        db.storeMessage(accountId, result.key.id, result.message, 'out', jid)
          .catch(e => logger.debug(`[MsgStore] Async DB store failed: ${e.message}`));
      } else {
        logger.warn(`[MsgStore] ⚠️ Could not store message - missing key.id or message body`);
      }

      await db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      });

      this.metrics.messagesProcessed++;

       // OPTIMIZED: Remove aggressive flush on every message
       // The 'creds.update' event is already debounced and handles key rotation.
       // We trust the 500ms debounce we added earlier to catch this without hammering DB.
       
      return {
        success: true,
        messageId: result.key.id,
        timestamp: Math.floor(Date.now() / 1000)
      };
    } catch (error) {
      this.metrics.messagesFailed++;
      throw error;
    }
    // Note: No gating needed - keys are saved atomically by createAtomicKeyStore
  }

  async sendMedia(accountId, number, media, caption = '', options = {}) {
    // PRE-CHECK: just to fail fast, but we'll fetch again later
    if (!this.clients.has(accountId)) throw new Error('Client not found');

    try {
      let base64Data = media.data || '';
      let mimetype = media.mimetype || '';
      let filename = media.filename || '';

      // ... existing media processing ...
      // Fetch from URL if needed
      if (media.url && !base64Data) {
        const response = await axios.get(media.url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 16 * 1024 * 1024
        });

        base64Data = Buffer.from(response.data).toString('base64');
        mimetype = mimetype || response.headers['content-type'] || 'application/octet-stream';

        if (!filename) {
          try {
            filename = new URL(media.url).pathname.split('/').pop() || '';
          } catch {}
        }
      }

      // Normalize base64
      if (base64Data && /^data:[^;]+;base64,/i.test(base64Data)) {
        base64Data = base64Data.replace(/^data:[^;]+;base64,/i, '');
      }

      if (!mimetype) throw new Error('mimetype required');

      const jid = this.formatPhoneNumber(number);
      const buffer = Buffer.from(base64Data, 'base64');

      // Anti-ban: Wait for rate limit with jitter
      await rateLimiter.waitWithJitter(accountId);

      // CRITICAL FIX: Fetch socket *AFTER* the delay to ensure it's not stale/disconnected
      const sock = this.clients.get(accountId);
      const status = this.accountStatus.get(accountId);
      
      if (!sock || status !== 'ready') {
        throw new Error(`Client not ready after wait: ${status || 'unknown'}`);
      }

      // Show typing indicator with jitter (don't fail media send on presence errors)
      // ANTI-BAN: Longer, more natural typing simulation
      const typingDelay = parseInt(process.env.TYPING_DELAY_MS) || 2500; // 2.5s base
      const typingJitter = Math.floor(Math.random() * 1500); // 0-1.5s random
      if (typingDelay > 0) {
        try {
          await sock.presenceSubscribe(jid);
          await sock.sendPresenceUpdate('composing', jid);
          await new Promise(resolve => setTimeout(resolve, typingDelay + typingJitter));
          await sock.sendPresenceUpdate('paused', jid);
        } catch (e) { /* ignore presence errors */ }
      }

      // Determine message type based on mimetype
      let messageContent;
      if (mimetype.startsWith('image/')) {
        messageContent = { image: buffer, caption, mimetype };
      } else if (mimetype.startsWith('video/')) {
        messageContent = { video: buffer, caption, mimetype };
      } else if (mimetype.startsWith('audio/')) {
        messageContent = { audio: buffer, mimetype, ptt: mimetype.includes('ogg') };
      } else {
        messageContent = { document: buffer, mimetype, fileName: filename || 'file' };
      }

      const result = await sock.sendMessage(jid, messageContent);

      // Store in global store for retry support
      // CRITICAL: Store result.message (the actual proto.IMessage), NOT messageContent (the input)
      if (result?.key?.id && result.message) {
        // L1: Memory cache
        if (globalMessageStore.size >= MESSAGE_STORE_MAX_SIZE) {
          const oldestKey = globalMessageStore.keys().next().value;
          globalMessageStore.delete(oldestKey);
        }
        globalMessageStore.set(result.key.id, {
          message: result.message,  // FIXED: Store proto.IMessage, not input
          timestamp: Date.now(),
          accountId
        });
        
        logger.info(`[MsgStore] ✅ Stored outgoing media ${result.key.id?.slice(0, 15)}... for retry support`);
        
        // L2: Database persistence
        db.storeMessage(accountId, result.key.id, result.message, 'out', jid)
          .catch(e => logger.debug(`[MsgStore] Async DB store failed: ${e.message}`));
      } else {
        logger.warn(`[MsgStore] ⚠️ Could not store media message - missing key.id or message body`);
      }

      // Record message for rate limiting
      rateLimiter.recordMessage(accountId);

      this.metrics.messagesProcessed++;

      return {
        success: true,
        messageId: result.key?.id,
        timestamp: Math.floor(Date.now() / 1000)
      };
    } catch (error) {
      this.metrics.messagesFailed++;
      throw error;
    }
    // Note: No gating needed - keys are saved atomically by createAtomicKeyStore
  }

  /**
   * Send buttons as formatted text message with numbered options
   * 
   * NOTE: Native interactive buttons (nativeFlowMessage) DO NOT WORK on personal
   * WhatsApp accounts connected via WhatsApp Web/Baileys. WhatsApp silently drops them.
   * Only WhatsApp Business API accounts can send clickable buttons.
   * 
   * This implementation uses text-based numbered options which work universally.
   */
  async sendButtons(accountId, number, body, buttons, title = '', footer = '', media = null) {
    logger.info(`[sendButtons] Called: accountId=${accountId}, number=${number}, body="${body?.slice(0,50)}...", buttons=${JSON.stringify(buttons)}`);
    
    const sock = this.clients.get(accountId);
    if (!sock) {
      logger.error(`[sendButtons] No socket found for account ${accountId}`);
      throw new Error('Account not connected');
    }

    const status = this.accountStatus.get(accountId);
    logger.info(`[sendButtons] Account status: ${status}`);
    if (status !== 'ready') {
      logger.error(`[sendButtons] Account not ready: ${status}`);
      throw new Error(`Client not ready: ${status}`);
    }

    // Use the module-level rateLimiter
    const delay = rateLimiter.getRequiredDelay(accountId);
    if (delay > 0) {
      logger.info(`[sendButtons] Rate limit delay: ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Format phone number
    const jid = number.includes('@') ? number : `${number.replace(/[^\d]/g, '')}@s.whatsapp.net`;
    logger.info(`[sendButtons] Formatted JID: ${jid}`);

    // Build text message with numbered options
    let messageText = '';
    if (title) messageText += `*${title}*\n\n`;
    messageText += body || '';
    messageText += '\n\n';
    
    if (Array.isArray(buttons)) {
      buttons.forEach((btn, i) => {
        const buttonText = btn.body || btn.buttonText?.displayText || btn.text || btn.title || String(btn);
        messageText += `${i + 1}. ${buttonText}\n`;
      });
    }
    
    if (footer) messageText += `\n_${footer}_`;
    messageText = messageText.trim();

    logger.info(`[sendButtons] Built message text (${messageText.length} chars):\n${messageText}`);

    // If media is provided, send as media with caption
    if (media && media.data) {
      logger.info(`[sendButtons] Sending with media: ${media.mimetype}`);
      const buffer = Buffer.from(media.data, 'base64');
      const mimetype = media.mimetype || 'application/octet-stream';
      
      let messageContent;
      if (mimetype.startsWith('image/')) {
        messageContent = { image: buffer, caption: messageText };
      } else if (mimetype.startsWith('video/')) {
        messageContent = { video: buffer, caption: messageText };
      } else {
        messageContent = { document: buffer, mimetype, fileName: media.filename || 'file', caption: messageText };
      }
      
      const result = await sock.sendMessage(jid, messageContent);
      logger.info(`[sendButtons] ✅ Media message sent: ${result?.key?.id}`);
      rateLimiter.recordMessage(accountId);
      this.metrics.messagesProcessed++;
      
      return {
        success: true,
        messageId: result.key?.id,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'media_with_options'
      };
    }

    // No media - send as plain text
    logger.info(`[sendButtons] Sending as plain text to ${jid}...`);
    const result = await sock.sendMessage(jid, { text: messageText });
    logger.info(`[sendButtons] ✅ Text message sent: ${result?.key?.id}`);
    
    rateLimiter.recordMessage(accountId);
    
    // Store for retry support
    // CRITICAL: Store result.message (the actual proto.IMessage), NOT input
    if (result?.key?.id && result.message) {
      // L1: Memory cache
      if (globalMessageStore.size >= MESSAGE_STORE_MAX_SIZE) {
        const oldestKey = globalMessageStore.keys().next().value;
        globalMessageStore.delete(oldestKey);
      }
      globalMessageStore.set(result.key.id, {
        message: result.message,  // FIXED: Store proto.IMessage
        timestamp: Date.now(),
        accountId
      });
      
      logger.info(`[MsgStore] ✅ Stored buttons message ${result.key.id?.slice(0, 15)}... for retry support`);
      
      // L2: Database persistence
      db.storeMessage(accountId, result.key.id, result.message, 'out', jid)
        .catch(e => logger.debug(`[MsgStore] Async DB store failed: ${e.message}`));
    }
    
    this.metrics.messagesProcessed++;

    return {
      success: true,
      messageId: result.key?.id,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text_options'
    };
  }

  /**
   * Send list as formatted text message with sections and numbered options
   * 
   * NOTE: Native interactive lists (nativeFlowMessage) DO NOT WORK on personal
   * WhatsApp accounts connected via WhatsApp Web/Baileys. WhatsApp silently drops them.
   * Only WhatsApp Business API accounts can send interactive lists.
   * 
   * This implementation uses text-based formatting which works universally.
   */
  async sendList(accountId, number, body, buttonText, sections, title = '', footer = '') {
    const sock = this.clients.get(accountId);
    if (!sock) throw new Error('Account not connected');

    // Use the module-level rateLimiter
    const delay = rateLimiter.getRequiredDelay(accountId);
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Format phone number
    const jid = number.includes('@') ? number : `${number.replace(/[^\d]/g, '')}@s.whatsapp.net`;

    // Validate sections
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new Error('List must have at least one section with rows');
    }

    // Build text message with sections and numbered options
    let messageText = '';
    if (title) messageText += `*${title}*\n\n`;
    messageText += body || '';
    messageText += '\n';
    
    let optionNum = 1;
    sections.forEach((section) => {
      if (!Array.isArray(section.rows) || section.rows.length === 0) return;
      
      // Section header
      if (section.title) {
        messageText += `\n*${section.title}*\n`;
      } else {
        messageText += '\n';
      }
      
      // Section rows as numbered options
      section.rows.forEach((row) => {
        const rowTitle = row.title || row;
        if (!rowTitle) return;
        
        messageText += `${optionNum}. ${rowTitle}`;
        if (row.description) {
          messageText += ` - _${row.description}_`;
        }
        messageText += '\n';
        optionNum++;
      });
    });
    
    if (footer) messageText += `\n_${footer}_`;
    messageText = messageText.trim();

    // Send as plain text
    const result = await sock.sendMessage(jid, { text: messageText });
    
    rateLimiter.recordMessage(accountId);
    
    // Store for retry support
    // CRITICAL: Store result.message (the actual proto.IMessage), NOT input
    if (result?.key?.id && result.message) {
      // L1: Memory cache
      if (globalMessageStore.size >= MESSAGE_STORE_MAX_SIZE) {
        const oldestKey = globalMessageStore.keys().next().value;
        globalMessageStore.delete(oldestKey);
      }
      globalMessageStore.set(result.key.id, {
        message: result.message,  // FIXED: Store proto.IMessage
        timestamp: Date.now(),
        accountId
      });
      
      logger.info(`[MsgStore] ✅ Stored list message ${result.key.id?.slice(0, 15)}... for retry support`);
      
      // L2: Database persistence
      db.storeMessage(accountId, result.key.id, result.message, 'out', jid)
        .catch(e => logger.debug(`[MsgStore] Async DB store failed: ${e.message}`));
    }
    
    this.metrics.messagesProcessed++;

    return {
      success: true,
      messageId: result.key?.id,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text_list'
    };
  }

  getQRCode(accountId) {
    return this.qrCodes.get(accountId);
  }

  getAccountStatus(accountId) {
    return this.accountStatus.get(accountId);
  }

  isReconnecting(accountId) {
    return this.reconnecting.has(accountId);
  }

  getAllAccountStatuses() {
    const statuses = {};
    for (const [accountId, status] of this.accountStatus) {
      statuses[accountId] = status;
    }
    return statuses;
  }

  async requestNewQRCode(accountId) {
    const account = await db.getAccount(accountId);
    if (!account) throw new Error('Account not found');

    return this.reconnectAccount(account, {
      forceReconnect: true,
      reason: 'qr_request'
    });
  }

  async ensureQRCode(accountId) {
    const hasQR = this.qrCodes.has(accountId);
    if (hasQR) return { status: this.accountStatus.get(accountId) || 'qr_ready' };

    const account = await db.getAccount(accountId);
    if (!account) throw new Error('Account not found');

    if (this.reconnecting.has(accountId)) {
      return { status: 'reconnecting' };
    }

    return this.reconnectAccount(account, {
      forceReconnect: true,
      reason: 'qr_ensure'
    });
  }

  async deleteAccount(accountId) {
    try {
      // Mark as deleted FIRST to prevent QR regeneration/reconnection
      this.deletedAccounts.add(accountId);
      logger.info(`Marking account ${accountId} as deleted - stopping all activity`);

      await this.safeDisposeClient(accountId);

      this.qrCodes.delete(accountId);
      this.accountStatus.delete(accountId);
      this.reconnecting.delete(accountId);
      this.qrAttempts.delete(accountId);

      // Clear session files
      const sessionPath = path.join('./wa-sessions-temp', accountId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      await db.clearSessionData(accountId);
      await db.deleteAccount(accountId);

      logger.info(`Account deleted: ${accountId}`);

      if (global.gc) global.gc();

      return true;
    } catch (error) {
      logger.error(`Delete account error:`, error);
      throw error;
    }
  }

  async initializeExistingAccounts() {
    if (process.env.DISABLE_AUTO_INIT === 'true') {
      logger.info('Auto-init disabled');
      return;
    }

    try {
      const accounts = await db.getAccounts();
      logger.info(`Found ${accounts.length} accounts`);

      // STEP 1: Check which accounts have valid auth in database
      const accountsToRestore = [];
      const accountsNeedingQR = [];

      for (const account of accounts) {
        try {
          const hasSession = await db.hasSessionData(account.id);

          if (hasSession) {
            accountsToRestore.push(account);
            logger.info(`✅ ${account.name} has saved auth`);
          } else {
            accountsNeedingQR.push(account);
            this.accountStatus.set(account.id, 'needs_qr');
            logger.info(`⚠️ ${account.name} needs QR scan`);
          }
        } catch (err) {
          this.accountStatus.set(account.id, 'error');
          logger.error(`Error checking auth for ${account.id}: ${err.message}`);
        }
      }

      logger.info(`${accountsToRestore.length}/${accounts.length} have saved auth`);

      // STEP 2: Connect accounts with auth ONE BY ONE with delay
      // ANTI-BAN: Limit connections per startup window to prevent bot farm detection
      const MAX_ACCOUNTS_PER_STARTUP = 3; // Max 3 accounts per startup burst
      let connectedCount = 0;
      
      for (const account of accountsToRestore) {
        // ANTI-BAN: If we've connected max accounts, wait longer
        if (connectedCount >= MAX_ACCOUNTS_PER_STARTUP) {
          logger.warn(`[Startup] Connected ${MAX_ACCOUNTS_PER_STARTUP} accounts - waiting 10 minutes before more...`);
          await new Promise(resolve => setTimeout(resolve, 600000)); // 10 minute cooldown
          connectedCount = 0;
        }
        
        try {
          logger.info(`[Startup] Connecting ${account.name}...`);
          
          await this.reconnectAccount(account, {
            skipIfNoSession: false,
            reason: 'startup'
          });
          
          connectedCount++;

          // ANTI-BAN: Wait 30-60 seconds between connects (was 10-20s)
          const delay = 30000 + Math.random() * 30000;
          logger.info(`[Startup] Waiting ${Math.round(delay/1000)}s before next account...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          
        } catch (err) {
          logger.error(`Startup connect failed for ${account.id}: ${err.message}`);
          this.accountStatus.set(account.id, 'error');
          
          // If auth restore failed, mark as needing QR
          if (err.message.includes('auth') || err.message.includes('creds')) {
            await db.clearSessionData(account.id);
            this.accountStatus.set(account.id, 'needs_qr');
          }
        }
      }

      logger.info('Finished initializing accounts');
    } catch (error) {
      logger.error('Init accounts error:', error);
    }
  }

  async reconnectAccount(account, options = {}) {
    const { forceReconnect = false, reason = 'manual', skipIfNoSession = false } = options;

    logger.info(`Reconnecting ${account.id} (${account.name}). Reason: ${reason}`);

    if (this.reconnecting.has(account.id)) {
      logger.warn(`Already reconnecting ${account.id}`);
      return { status: 'reconnecting' };
    }

    // Dispose existing client
    if (this.clients.has(account.id)) {
      const currentStatus = this.accountStatus.get(account.id);
      if (!forceReconnect && currentStatus === 'ready') {
        return { status: currentStatus };
      }
      await this.safeDisposeClient(account.id);
    }

    // Check for session
    let hasSession = false;
    try {
      hasSession = await db.hasSessionData(account.id);
    } catch (err) {
      logger.warn(`Could not check session for ${account.id}`);
    }

    if (!hasSession && skipIfNoSession) {
      logger.info(`No session for ${account.id}, skipping`);
      await db.updateAccount(account.id, {
        status: 'disconnected',
        error_message: 'No saved session - QR scan required',
        updated_at: new Date().toISOString()
      }).catch(() => {});
      return { status: 'disconnected' };
    }

    this.reconnecting.add(account.id);

    try {
      await db.updateAccount(account.id, {
        status: 'initializing',
        error_message: null,
        updated_at: new Date().toISOString()
      }).catch(() => {});

      this.qrCodes.delete(account.id);

      await this.startBaileysClient(account.id);

      // Remove from reconnecting set after a delay
      setTimeout(() => {
        this.reconnecting.delete(account.id);
      }, 5000);

      return { status: 'initializing' };
    } catch (error) {
      logger.error(`Reconnect error for ${account.id}:`, error);

      await db.updateAccount(account.id, {
        status: 'disconnected',
        error_message: error.message,
        updated_at: new Date().toISOString()
      }).catch(() => {});

      this.accountStatus.set(account.id, 'disconnected');
      this.reconnecting.delete(account.id);
      throw error;
    }
  }

  async cleanupDisconnectedAccounts() {
    try {
      for (const [accountId, status] of this.accountStatus) {
        if (status === 'disconnected' || status === 'error') {
          const client = this.clients.get(accountId);
          if (client) {
            logger.info(`Cleaning up ${accountId}`);
            await this.safeDisposeClient(accountId);
          }
        }
      }

      if (global.gc) global.gc();
    } catch (error) {
      logger.error('Cleanup error:', error);
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeClients: this.clients.size
    };
  }

  async shutdown() {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    logger.info(`[Shutdown] Shutting down ${this.clients.size} client(s)...`);

    // Save all sessions to database before closing
    const savePromises = [];
    for (const [accountId, authState] of this.authStates.entries()) {
      if (authState?.sessionPath) {
        logger.info(`[Shutdown] Saving ${accountId}...`);
        savePromises.push(
          saveAuthToDatabase(accountId, authState.sessionPath).catch(err => {
            logger.warn(`[Shutdown] Save failed for ${accountId}: ${err.message}`);
          })
        );
      }
    }
    
    // Wait for saves (with timeout)
    if (savePromises.length > 0) {
      await Promise.race([
        Promise.all(savePromises),
        new Promise(resolve => setTimeout(resolve, 10000))
      ]);
      logger.info(`[Shutdown] Session saves completed`);
    }

    // Close all sockets
    for (const [accountId, sock] of this.clients.entries()) {
      try {
        sock.end(undefined);
        logger.info(`Closed ${accountId}`);
      } catch (error) {
        logger.error(`Shutdown error for ${accountId}:`, error.message);
      }
    }

    this.clients.clear();
    this.accountStatus.clear();
    this.qrCodes.clear();
    this.reconnecting.clear();
    this.deletedAccounts.clear();
    this.authStates.clear();

    logger.info('WhatsAppManager shutdown complete');
  }
}

module.exports = new WhatsAppManager();
