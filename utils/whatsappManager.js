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
  // Check first arg if object
  const firstArg = args[0];
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
const AUTH_VERSION = 3;

// ============================================================================
// INSTANCE OWNERSHIP - Prevents dual-server connection bans
// ============================================================================
const os = require('os');
const INSTANCE_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;
const OWNERSHIP_STALE_MS = 5 * 60 * 1000; // 5 minutes = ownership expires

logger.info(`[Instance] ID: ${INSTANCE_ID}`);

/**
 * Generate stable per-account browser fingerprint
 * Uses account ID to seed deterministic but unique values
 * NEVER changes after account creation (consistency = safety)
 */
function getAccountBrowserFingerprint(accountId) {
  // Simple hash of accountId to generate stable numbers
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = ((hash << 5) - hash) + accountId.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  hash = Math.abs(hash);
  
  // Generate stable Chrome version (118-124 range)
  const majorVersion = 118 + (hash % 7);
  const minorVersion = (hash >> 8) % 10;
  const patchVersion = (hash >> 16) % 100;
  
  // Stable device name variations
  const deviceNames = ['WhatsApp Manager', 'WA Business', 'WA Connect', 'WA Hub', 'WA Link'];
  const deviceIndex = hash % deviceNames.length;
  
  return [deviceNames[deviceIndex], 'Chrome', `${majorVersion}.${minorVersion}.${patchVersion}`];
}

// ============================================================================
// BAILEYS AUTH STATE MANAGER
// ============================================================================
// 
// CORE PRINCIPLES (non-negotiable):
// 
// 1. Baileys auth is authoritative - never merge, always overwrite
// 2. One writer per account - use locks to prevent parallel saves  
// 3. Restore BEFORE connect - never connect without valid auth
// 4. Save on crypto change (creds.update), not on message send
// 5. One instance per account - prevent concurrent connections
//
// CRITICAL RULES:
//
// ❌ NEVER restore partial auth - if ANY component missing, discard ALL
// ❌ NEVER merge with existing data - always full overwrite
// ❌ NEVER connect before auth is restored
// ❌ NEVER skip stabilization save after connection.open
// ❌ NEVER allow two servers to connect same account
//
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

// Save locks to prevent parallel writes per account
const saveLocks = new Map(); // accountId -> boolean

// Track accounts in QR scanning phase (volatile local state)
const qrInProgress = new Set(); // accountId set

/**
 * Restore auth from Supabase to local files BEFORE socket creation
 * 
 * CRITICAL RULE: DATABASE IS THE SOURCE OF TRUTH.
 * Local filesystem is disposable cache - NEVER trust it over DB.
 * 
 * This function ALWAYS:
 * 1. Wipes local session directory first
 * 2. Fetches from database
 * 3. Validates completely before restoring
 * 
 * Returns: { restored: boolean, sessionPath: string, needsQR: boolean, ownedByOther: boolean }
 */
async function restoreAuthFromDatabase(accountId) {
  const sessionPath = path.join('./wa-sessions-temp', accountId);
  
  // ALWAYS start with clean directory - local files are NOT authoritative
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionPath, { recursive: true });

  try {
    const sessionData = await db.getSessionData(accountId);
    
    // No saved session - needs QR scan
    if (!sessionData || sessionData.length < 10) {
      logger.info(`[Auth] No saved session for ${accountId} - needs QR scan`);
      return { restored: false, sessionPath, needsQR: true, ownedByOther: false };
    }

    // Decode auth blob
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(sessionData, 'base64').toString('utf-8'));
    } catch (e) {
      logger.error(`[Auth] Corrupted auth blob for ${accountId} - clearing`);
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath, needsQR: true, ownedByOther: false };
    }

    // =========================================================================
    // VERSION CHECK - Schema safety
    // =========================================================================
    const savedVersion = decoded.version || 1;
    if (savedVersion < AUTH_VERSION) {
      logger.warn(`[Auth] Auth version mismatch for ${accountId}: saved=${savedVersion}, required=${AUTH_VERSION}`);
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath, needsQR: true, ownedByOther: false };
    }

    // =========================================================================
    // STRUCTURE VALIDATION - creds.me.id is the ONLY valid indicator
    // If me.id is missing, the session does not exist - period.
    // =========================================================================
    if (!decoded?.creds?.me?.id) {
      logger.warn(`[Auth] Auth for ${accountId} has no creds.me.id - invalid session`);
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath, needsQR: true, ownedByOther: false };
    }

    // Check for required Signal keys
    if (!decoded.keys || typeof decoded.keys !== 'object' || Object.keys(decoded.keys).length === 0) {
      logger.warn(`[Auth] Auth for ${accountId} has no keys - invalid session`);
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath, needsQR: true, ownedByOther: false };
    }

    // =========================================================================
    // FULL RESTORE - Write all files
    // =========================================================================
    fs.writeFileSync(
      path.join(sessionPath, 'creds.json'),
      JSON.stringify(decoded.creds, null, 2)
    );

    let keyCount = 0;
    for (const [filename, data] of Object.entries(decoded.keys)) {
      if (filename && data) {
        fs.writeFileSync(
          path.join(sessionPath, filename),
          JSON.stringify(data, null, 2)
        );
        keyCount++;
      }
    }

    logger.info(`[Auth] ✅ Restored auth for ${accountId}: v${savedVersion}, creds + ${keyCount} keys`);
    return { restored: true, sessionPath, needsQR: false, ownedByOther: false };

  } catch (err) {
    logger.error(`[Auth] Restore failed for ${accountId}: ${err.message}`);
    try {
      await db.clearSessionData(accountId);
      fs.rmSync(sessionPath, { recursive: true, force: true });
      fs.mkdirSync(sessionPath, { recursive: true });
    } catch {}
    return { restored: false, sessionPath, needsQR: true, ownedByOther: false };
  }
}

/**
 * Save auth to Supabase - ALWAYS overwrites, never merges
 * Uses lock to prevent parallel saves
 */
async function saveAuthToDatabase(accountId, sessionPath, force = false) {
  // Check lock
  if (saveLocks.get(accountId)) {
    if (!force) {
      logger.debug(`[Auth] Save already in progress for ${accountId}, skipping`);
      return false;
    }
    // If forced, wait for existing save
    let waitCount = 0;
    while (saveLocks.get(accountId) && waitCount < 50) {
      await new Promise(r => setTimeout(r, 100));
      waitCount++;
    }
  }

  saveLocks.set(accountId, true);

  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      logger.warn(`[Auth] No creds.json to save for ${accountId}`);
      return false;
    }

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));

    // Don't save incomplete auth (no me.id = not authenticated yet)
    if (!creds.me?.id) {
      logger.debug(`[Auth] Skipping save - auth not complete for ${accountId}`);
      return false;
    }

    // Collect ALL key files (complete snapshot)
    const keys = {};
    const files = fs.readdirSync(sessionPath);
    for (const file of files) {
      if (file !== 'creds.json' && file.endsWith('.json')) {
        try {
          keys[file] = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf-8'));
        } catch {}
      }
    }

    // Create complete auth blob with ownership and versioning
    const authBlob = {
      creds,
      keys,
      version: AUTH_VERSION,           // Schema version for migration safety
      activeInstanceId: INSTANCE_ID,   // Ownership guard - prevents concurrent connections
      savedAt: new Date().toISOString()
    };

    const base64 = Buffer.from(JSON.stringify(authBlob)).toString('base64');
    
    // UPSERT - always overwrite, never merge
    await db.saveSessionData(accountId, base64);
    
    logger.info(`[Auth] ✅ Saved auth for ${accountId}: v${AUTH_VERSION}, ${Object.keys(keys).length} keys, instance=${INSTANCE_ID.slice(-12)}`);
    return true;

  } catch (err) {
    logger.error(`[Auth] Save failed for ${accountId}: ${err.message}`);
    return false;
  } finally {
    saveLocks.set(accountId, false);
  }
}

/**
 * Create auth state wrapper with debounced saves
 */
async function useDBAuthState(accountId) {
  const sessionPath = path.join('./wa-sessions-temp', accountId);

  // Use Baileys' built-in file auth state
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Debounce configuration
  let saveTimeout = null;
  let lastSaveTime = 0;
  const SAVE_DEBOUNCE_MS = 15000; // Wait 15s for activity to settle
  const MIN_SAVE_INTERVAL_MS = 30000; // Min 30s between saves

  // Debounced save function
  const saveAllToDatabase = async (force = false) => {
    if (force) {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = null;
      await saveAuthToDatabase(accountId, sessionPath, true);
      return;
    }

    // Debounce
    if (saveTimeout) clearTimeout(saveTimeout);
    
    saveTimeout = setTimeout(async () => {
      const now = Date.now();
      if (now - lastSaveTime >= MIN_SAVE_INTERVAL_MS) {
        await saveAuthToDatabase(accountId, sessionPath, false);
        lastSaveTime = now;
      }
    }, SAVE_DEBOUNCE_MS);
  };

  // Wrap saveCreds to trigger database save
  const saveCredsAndDB = async () => {
    await saveCreds();
    await saveAllToDatabase();
  };

  return { state, saveCreds: saveCredsAndDB, saveAllToDatabase };
}

// ============================================================================
// ANTI-BAN: Message Rate Limiter (per account)
// ============================================================================
class AccountRateLimiter {
  constructor() {
    // Track message timestamps per account
    this.messageTimestamps = new Map(); // accountId -> [timestamps]
    this.lastMessageTime = new Map();   // accountId -> timestamp
    
    // Configurable limits
    this.minIntervalMs = parseInt(process.env.WA_MIN_MESSAGE_INTERVAL_MS) || 3000; // 3s between messages
    this.maxMessagesPerHour = parseInt(process.env.WA_MAX_MESSAGES_PER_HOUR) || 200;
    this.randomDelayMs = parseInt(process.env.WA_RANDOM_DELAY_MS) || 1000; // 0-1s random delay
    
    // Cleanup old timestamps every 10 minutes
    setInterval(() => this.cleanup(), 600000);
  }

  // Check if account can send a message, returns delay needed (0 = can send now)
  getRequiredDelay(accountId) {
    const now = Date.now();
    const lastTime = this.lastMessageTime.get(accountId) || 0;
    const elapsed = now - lastTime;
    
    if (elapsed < this.minIntervalMs) {
      return this.minIntervalMs - elapsed + Math.random() * this.randomDelayMs;
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
    this.lastMessageTime.set(accountId, now);
    
    const timestamps = this.messageTimestamps.get(accountId) || [];
    timestamps.push(now);
    this.messageTimestamps.set(accountId, timestamps);
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
    this.authStates = new Map();    // accountId -> { state, saveCreds }

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

    try {
      // STEP 1: Restore auth from database BEFORE creating socket
      // This is critical - never connect without restoring first
      // EXCEPTION: skipRestore=true during QR phase (restartRequired handling)
      if (!skipRestore) {
        const restoreResult = await restoreAuthFromDatabase(accountId);
        
        if (restoreResult.needsQR) {
          logger.info(`[Auth] Account ${accountId} needs QR scan`);
          this.accountStatus.set(accountId, 'needs_qr');
          // Mark as QR in progress - local files are now VOLATILE
          qrInProgress.add(accountId);
        } else {
          // Valid auth restored from DB - not in QR phase
          qrInProgress.delete(accountId);
        }
      }
      // If skipRestore=true, we're continuing an existing QR session
      // qrInProgress state remains unchanged

      // STEP 2: Create auth state from restored files
      const { state, saveCreds, saveAllToDatabase } = await useDBAuthState(accountId);
      this.authStates.set(accountId, { state, saveCreds, saveAllToDatabase });

      const { version } = await fetchLatestBaileysVersion();
      logger.info(`Using Baileys version: ${version.join('.')}`);

      // Store for message retry (fixes "Waiting for this message" issue)
      const messageRetryMap = new Map();

      // Per-account stable browser fingerprint (prevents cluster fingerprinting)
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
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        // Message retry configuration - fixes encryption issues
        retryRequestDelayMs: 250,
        getMessage: async (key) => {
          // Return cached message for retry
          if (messageRetryMap.has(key.id)) {
            return messageRetryMap.get(key.id);
          }
          return { conversation: '' };
        },
        msgRetryCounterCache: messageRetryMap
      });

      // Store messageRetryMap with the client for later use
      sock.messageRetryMap = messageRetryMap;

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
            // User may not have a profile picture
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
        this.reconnectAttempts.delete(accountId); // Reset backoff on successful connection
        
        // QR phase is complete - local state is now authoritative
        qrInProgress.delete(accountId);

        // =====================================================================
        // STABILIZATION SAVE - Mandatory first save after connection.open
        // =====================================================================
        // WHY THIS IS CRITICAL (do not remove or "optimize"):
        // - Some Signal keys finalize only AFTER connection opens
        // - History sync may create new pre-keys
        // - Without this save, a crash would lose the finalized keys
        // - This save also claims instance ownership in Supabase
        // =====================================================================
        const authState = this.authStates.get(accountId);
        if (authState?.saveAllToDatabase) {
          try {
            await authState.saveAllToDatabase(true); // Force immediate save
            logger.info(`[Auth] ✅ Stabilization save complete for ${accountId}`);
          } catch (e) {
            logger.error(`[Auth] ❌ Stabilization save failed: ${e.message}`);
          }
        }

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
        // This is NORMAL during QR scanning - don't spam reconnects
        const isRestartRequired = statusCode === 515 || statusCode === DisconnectReason.restartRequired;

        if (statusCode === DisconnectReason.loggedOut) {
          // User logged out - MUST clear all auth data
          logger.warn(`[Auth] Account ${accountId} logged out - clearing all auth`);
          
          // Clear QR in progress tracking
          qrInProgress.delete(accountId);
          
          // Clear database auth
          await db.clearSessionData(accountId);
          
          // Clear local files
          const sessionPath = path.join('./wa-sessions-temp', accountId);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          
          await db.updateAccount(accountId, {
            status: 'logged_out',
            error_message: 'Logged out - QR scan required',
            updated_at: new Date().toISOString()
          });
          this.accountStatus.set(accountId, 'logged_out');
          this.clients.delete(accountId);
          this.authStates.delete(accountId);
          this.reconnectAttempts.delete(accountId);
        } else if (isConnectionReplaced) {
          // connectionReplaced - another instance/device took over
          // Use exponential backoff to prevent reconnection loops
          const attempts = this.reconnectAttempts.get(accountId) || { count: 0, lastAttempt: 0 };
          const now = Date.now();
          
          // Reset attempts if last attempt was more than 5 minutes ago
          if (now - attempts.lastAttempt > 300000) {
            attempts.count = 0;
          }
          
          attempts.count++;
          attempts.lastAttempt = now;
          this.reconnectAttempts.set(accountId, attempts);
          
          // Exponential backoff: 10s, 30s, 60s, 120s, max 5 minutes
          const backoffMs = Math.min(10000 * Math.pow(2, attempts.count - 1), 300000);
          
          if (attempts.count > 5) {
            // Too many connectionReplaced errors - stop reconnecting
            logger.error(`Connection replaced too many times for ${accountId}. Check if WhatsApp Web is open elsewhere.`);
            await db.updateAccount(accountId, {
              status: 'disconnected',
              error_message: 'Connection replaced - WhatsApp may be open on another device/browser',
              updated_at: new Date().toISOString()
            }).catch(() => {});
            this.accountStatus.set(accountId, 'disconnected');
            this.clients.delete(accountId);
          } else {
            logger.info(`Connection replaced for ${accountId}. Waiting ${backoffMs/1000}s before attempt ${attempts.count}/5...`);
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
        } else if (isRestartRequired) {
          // =========================================================================
          // restartRequired (515) - Normal during QR scanning
          // This is NOT an error - it's Baileys' way of cycling the QR code
          //
          // CRITICAL: If QR is in progress, DO NOT call restoreAuthFromDatabase()
          // Local files contain in-progress handshake state that must be preserved.
          // Use skipRestore=true to recreate socket without wiping local files.
          // =========================================================================
          const isQrPhase = qrInProgress.has(accountId);
          logger.info(`[QR] Restart required for ${accountId} - QR in progress: ${isQrPhase}`);
          this.accountStatus.set(accountId, 'qr_ready');
          
          // Wait 5 seconds before generating new QR
          setTimeout(async () => {
            if (!this.isShuttingDown && !this.deletedAccounts.has(accountId)) {
              const currentStatus = this.accountStatus.get(accountId);
              // Only reconnect if still waiting for QR (not if already connected)
              if (currentStatus !== 'ready') {
                logger.info(`[QR] Generating new QR for ${accountId}...`);
                try {
                  // During QR phase: skipRestore=true to preserve volatile local files
                  // After auth complete: skipRestore=false to restore from DB
                  const skipRestore = qrInProgress.has(accountId);
                  await this.startBaileysClient(accountId, skipRestore);
                } catch (err) {
                  logger.error(`[QR] Failed to regenerate QR for ${accountId}:`, err.message);
                  this.accountStatus.set(accountId, 'disconnected');
                }
              }
            }
          }, 5000);
        } else if (shouldReconnect && !this.isShuttingDown) {
          // Normal disconnect - try to reconnect after 3 seconds
          this.accountStatus.set(accountId, 'reconnecting');
          this.reconnectAttempts.delete(accountId); // Reset for normal reconnects
          
          setTimeout(async () => {
            // Don't reconnect if account was deleted or shutting down
            if (!this.isShuttingDown && !this.reconnecting.has(accountId) && !this.deletedAccounts.has(accountId)) {
              logger.info(`Attempting reconnect for ${accountId}...`);
              try {
                await this.startBaileysClient(accountId);
              } catch (err) {
                logger.error(`Reconnect failed for ${accountId}:`, err.message);
                this.accountStatus.set(accountId, 'disconnected');
              }
            } else if (this.deletedAccounts.has(accountId)) {
              logger.info(`Skipping reconnect - account ${accountId} was deleted`);
            }
          }, 3000);
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

    // Credentials updated - save to database (debounced)
    sock.ev.on('creds.update', saveCreds);

    // History sync - triggers debounced save (creates many Signal keys)
    sock.ev.on('messaging-history.set', async () => {
      const authState = this.authStates.get(accountId);
      if (authState?.saveAllToDatabase) {
        authState.saveAllToDatabase().catch(() => {});
      }
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

    // Incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          await this.handleIncomingMessage(sock, accountId, message);
        } catch (error) {
          logger.error(`Message handler error for ${accountId}:`, error);
        }
      }
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
              // Reduce typing delay for faster response (500ms instead of 1500ms default)
              const originalTypingDelay = process.env.TYPING_DELAY_MS;
              process.env.TYPING_DELAY_MS = '500';
              
              logger.info(`[Chatbot] Sending response to ${chatPhone}...`);
              
              // Send directly using sock.sendMessage with the exact JID
              const sock = this.clients.get(accountId);
              if (sock) {
                // Show typing
                try {
                  await sock.presenceSubscribe(replyJid);
                  await sock.sendPresenceUpdate('composing', replyJid);
                  await new Promise(resolve => setTimeout(resolve, 500));
                  await sock.sendPresenceUpdate('paused', replyJid);
                } catch {}
                
                const result = await sock.sendMessage(replyJid, { text: aiResponse });
                logger.info(`[Chatbot] ✅ Response sent to ${chatPhone} (msgId: ${result?.key?.id?.slice(0, 10)}...)`);
              }
              
              // Restore original typing delay
              if (originalTypingDelay !== undefined) {
                process.env.TYPING_DELAY_MS = originalTypingDelay;
              } else {
                delete process.env.TYPING_DELAY_MS;
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
    const sock = this.clients.get(accountId);
    if (!sock) throw new Error('Client not found');

    const status = this.accountStatus.get(accountId);
    if (status !== 'ready') throw new Error(`Client not ready: ${status}`);

    const jid = this.formatPhoneNumber(number);

    try {
      // Anti-ban: Wait for rate limit with jitter
      await rateLimiter.waitWithJitter(accountId);

      // Show typing indicator (human-like behavior)
      const typingDelay = parseInt(process.env.TYPING_DELAY_MS) || 1500;
      const typingJitter = Math.floor(Math.random() * 500); // 0-500ms random
      if (typingDelay > 0) {
        try {
          await sock.presenceSubscribe(jid);
          await sock.sendPresenceUpdate('composing', jid);
          await new Promise(resolve => setTimeout(resolve, typingDelay + typingJitter));
          await sock.sendPresenceUpdate('paused', jid);
        } catch (e) { /* ignore presence errors */ }
      }

      // Create message content
      const msgContent = { text: message };
      
      const result = await sock.sendMessage(jid, msgContent);

      // Record message for rate limiting
      rateLimiter.recordMessage(accountId);

      // Cache message for retry (fixes "Waiting for this message" issue)
      if (sock.messageRetryMap && result?.key?.id) {
        sock.messageRetryMap.set(result.key.id, msgContent);
        // Clean up old entries after 5 minutes
        setTimeout(() => sock.messageRetryMap?.delete(result.key.id), 5 * 60 * 1000);
      }
      // Note: Session keys are saved via creds.update event when they change

      await db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      });

      this.metrics.messagesProcessed++;

      return {
        success: true,
        messageId: result.key.id,
        timestamp: Math.floor(Date.now() / 1000)
      };
    } catch (error) {
      this.metrics.messagesFailed++;
      throw error;
    }
  }

  async sendMedia(accountId, number, media, caption = '', options = {}) {
    const sock = this.clients.get(accountId);
    if (!sock) throw new Error('Client not found');

    const status = this.accountStatus.get(accountId);
    if (status !== 'ready') throw new Error(`Client not ready: ${status}`);

    let base64Data = media.data || '';
    let mimetype = media.mimetype || '';
    let filename = media.filename || '';

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

    // Show typing indicator with jitter (don't fail media send on presence errors)
    const typingDelay = parseInt(process.env.TYPING_DELAY_MS) || 1500;
    const typingJitter = Math.floor(Math.random() * 500); // 0-500ms random
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

    // Record message for rate limiting
    rateLimiter.recordMessage(accountId);

    this.metrics.messagesProcessed++;

    return {
      success: true,
      messageId: result.key?.id,
      timestamp: Math.floor(Date.now() / 1000)
    };
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
    
    // Cache for retry
    if (sock.messageRetryMap && result?.key?.id) {
      sock.messageRetryMap.set(result.key.id, { text: messageText });
      setTimeout(() => sock.messageRetryMap?.delete(result.key.id), 5 * 60 * 1000);
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
    
    // Cache for retry
    if (sock.messageRetryMap && result?.key?.id) {
      sock.messageRetryMap.set(result.key.id, { text: messageText });
      setTimeout(() => sock.messageRetryMap?.delete(result.key.id), 5 * 60 * 1000);
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
      qrInProgress.delete(accountId); // Clear QR tracking
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
      // This prevents burst reconnect patterns that trigger bans
      for (const account of accountsToRestore) {
        try {
          logger.info(`[Startup] Connecting ${account.name}...`);
          
          await this.reconnectAccount(account, {
            skipIfNoSession: false,
            reason: 'startup'
          });

          // Wait 3-5 seconds between connects (anti-ban)
          const delay = 3000 + Math.random() * 2000;
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
    logger.info(`[Shutdown] Instance ${INSTANCE_ID} releasing ownership...`);

    // First, save all sessions with ownership release
    // Note: We save with current instance ID - next startup will see stale ownership
    // and take over after the staleness threshold (5 minutes)
    const savePromises = [];
    for (const [accountId, authState] of this.authStates.entries()) {
      if (authState?.saveAllToDatabase) {
        logger.info(`[Shutdown] Final save for ${accountId}...`);
        savePromises.push(
          authState.saveAllToDatabase(true).catch(err => {
            logger.warn(`[Shutdown] Failed to save session for ${accountId}: ${err.message}`);
          })
        );
      }
    }
    
    // Wait for all session saves to complete (with timeout)
    if (savePromises.length > 0) {
      await Promise.race([
        Promise.all(savePromises),
        new Promise(resolve => setTimeout(resolve, 10000)) // 10s timeout
      ]);
      logger.info(`[Shutdown] Session saves completed`);
    }

    // Then close all sockets
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
