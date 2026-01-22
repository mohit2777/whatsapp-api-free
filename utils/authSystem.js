/**
 * ============================================================================
 * ROBUST AUTH & SESSION MANAGEMENT SYSTEM
 * ============================================================================
 * 
 * This module implements a comprehensive authentication and session management
 * system designed to be undetectable by WhatsApp as an unofficial API.
 * 
 * Key Features:
 * - Realistic device fingerprinting with persistent device IDs
 * - Atomic auth state operations with corruption recovery
 * - Human-like behavior simulation
 * - Proper Signal protocol key lifecycle management
 * - Multi-layer caching (Memory → Database)
 * - Intelligent reconnection with jitter
 * 
 * Based on Evolution API patterns and WhatsApp Web reverse engineering
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const logger = require('./logger');

// ============================================================================
// CONSTANTS
// ============================================================================

// Auth schema version - increment when key format changes
const AUTH_SCHEMA_VERSION = 5;

// Paths
const AUTH_ROOT = path.join(process.cwd(), 'auth_states');
const DEVICE_REGISTRY = path.join(AUTH_ROOT, '.device_registry.json');

// Device fingerprint pools (realistic combinations from real devices)
const DEVICE_POOLS = {
  // Real Chrome versions seen in the wild (2024)
  chromeVersions: [
    '120.0.6099.199', '120.0.6099.216', '120.0.6099.224',
    '121.0.6167.85', '121.0.6167.139', '121.0.6167.160', '121.0.6167.184',
    '122.0.6261.57', '122.0.6261.69', '122.0.6261.94', '122.0.6261.111', '122.0.6261.128',
    '123.0.6312.58', '123.0.6312.86', '123.0.6312.105', '123.0.6312.122',
    '124.0.6367.60', '124.0.6367.78', '124.0.6367.91', '124.0.6367.118',
    '125.0.6422.60', '125.0.6422.76', '125.0.6422.112', '125.0.6422.141',
    '126.0.6478.55', '126.0.6478.61', '126.0.6478.114', '126.0.6478.126',
    '127.0.6533.72', '127.0.6533.88', '127.0.6533.99', '127.0.6533.119',
    '128.0.6613.84', '128.0.6613.113', '128.0.6613.137',
    '129.0.6668.58', '129.0.6668.70', '129.0.6668.89', '129.0.6668.100',
    '130.0.6723.58', '130.0.6723.69', '130.0.6723.91', '130.0.6723.116',
    '131.0.6778.69', '131.0.6778.85', '131.0.6778.108', '131.0.6778.139',
    '132.0.6834.83', '132.0.6834.110', '132.0.6834.159'
  ],
  
  // Platform strings (weighted towards Windows as most common)
  platforms: [
    // Windows variants (70% usage)
    { os: 'Windows', weight: 70, variants: [
      'Windows 10', 'Windows 11', 'Windows',
      'Win10', 'Win11', 'Win64', 'x64'
    ]},
    // macOS variants (20% usage)
    { os: 'macOS', weight: 20, variants: [
      'macOS', 'Mac OS X', 'Macintosh', 'Mac',
      'Darwin', 'Intel Mac OS X'
    ]},
    // Linux variants (10% usage)
    { os: 'Linux', weight: 10, variants: [
      'Linux', 'Ubuntu', 'X11', 'Linux x86_64'
    ]}
  ],
  
  // Browser names that WhatsApp Web accepts
  browsers: [
    'Chrome', 'Google Chrome', 'Chromium', 'Chrome WebView'
  ],
  
  // WhatsApp Web internal client version patterns
  waVersions: [
    '2.3000.', '2.2413.', '2.2412.', '2.2411.'
  ]
};

// Timing constants for human-like behavior
const TIMING = {
  // Typing simulation: 30-60 WPM = 100-200ms per char
  typingMinMs: 50,
  typingMaxMs: 150,
  
  // Presence update delays (human doesn't go online/offline instantly)
  presenceDelayMinMs: 500,
  presenceDelayMaxMs: 2000,
  
  // Connection establishment (humans take time to click connect)
  connectDelayMinMs: 1000,
  connectDelayMaxMs: 3000,
  
  // Reconnect backoff
  reconnectBaseMs: 5000,
  reconnectMaxMs: 300000, // 5 minutes max
  reconnectJitterRatio: 0.3, // 30% jitter
  
  // Activity intervals
  heartbeatMinMs: 25000,
  heartbeatMaxMs: 35000,
  
  // Session validation interval
  sessionCheckIntervalMs: 60000
};

// ============================================================================
// DEVICE FINGERPRINT MANAGER
// ============================================================================

class DeviceFingerprintManager {
  constructor() {
    this.registry = new Map();
    this.loaded = false;
  }
  
  /**
   * Load device registry from disk
   */
  async load() {
    if (this.loaded) return;
    
    try {
      await fs.mkdir(AUTH_ROOT, { recursive: true });
      
      if (fsSync.existsSync(DEVICE_REGISTRY)) {
        const data = await fs.readFile(DEVICE_REGISTRY, 'utf8');
        const parsed = JSON.parse(data);
        
        for (const [accountId, fingerprint] of Object.entries(parsed)) {
          this.registry.set(accountId, fingerprint);
        }
        
        logger.info(`[DeviceFP] Loaded ${this.registry.size} device fingerprints from registry`);
      }
    } catch (error) {
      logger.warn(`[DeviceFP] Failed to load registry, starting fresh: ${error.message}`);
    }
    
    this.loaded = true;
  }
  
  /**
   * Save device registry to disk (atomic write)
   */
  async save() {
    const tempPath = DEVICE_REGISTRY + '.tmp';
    const data = Object.fromEntries(this.registry);
    
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
      await fs.rename(tempPath, DEVICE_REGISTRY);
    } catch (error) {
      logger.error(`[DeviceFP] Failed to save registry: ${error.message}`);
      // Cleanup temp file if exists
      try { await fs.unlink(tempPath); } catch {}
    }
  }
  
  /**
   * Generate a stable, unique device fingerprint for an account
   * The same account always gets the same fingerprint
   */
  async getFingerprint(accountId) {
    await this.load();
    
    // Check if we already have a fingerprint for this account
    if (this.registry.has(accountId)) {
      return this.registry.get(accountId);
    }
    
    // Generate new fingerprint with deterministic seed from accountId
    const fingerprint = this._generateFingerprint(accountId);
    this.registry.set(accountId, fingerprint);
    await this.save();
    
    logger.info(`[DeviceFP] Generated new fingerprint for ${accountId}: ${fingerprint.browser[0]} on ${fingerprint.browser[1]}`);
    
    return fingerprint;
  }
  
  /**
   * Generate a realistic device fingerprint
   * Uses accountId as seed for deterministic but unique values
   */
  _generateFingerprint(accountId) {
    // Create deterministic random generator from accountId
    const seed = crypto.createHash('sha256').update(accountId + 'device_fp_v2').digest();
    let seedIndex = 0;
    
    const getRandom = () => {
      const value = seed.readUInt32BE(seedIndex % (seed.length - 4));
      seedIndex += 4;
      return value / 0xFFFFFFFF;
    };
    
    // Select platform based on weight
    const platformRoll = getRandom() * 100;
    let cumulativeWeight = 0;
    let selectedPlatform = DEVICE_POOLS.platforms[0];
    
    for (const platform of DEVICE_POOLS.platforms) {
      cumulativeWeight += platform.weight;
      if (platformRoll <= cumulativeWeight) {
        selectedPlatform = platform;
        break;
      }
    }
    
    // Pick a variant from the platform
    const variantIndex = Math.floor(getRandom() * selectedPlatform.variants.length);
    const platformString = selectedPlatform.variants[variantIndex];
    
    // Pick Chrome version
    const chromeIndex = Math.floor(getRandom() * DEVICE_POOLS.chromeVersions.length);
    const chromeVersion = DEVICE_POOLS.chromeVersions[chromeIndex];
    
    // Pick browser name
    const browserIndex = Math.floor(getRandom() * DEVICE_POOLS.browsers.length);
    const browserName = DEVICE_POOLS.browsers[browserIndex];
    
    // Generate a unique device ID that persists
    const deviceId = crypto.createHash('sha256')
      .update(accountId + 'device_id_v2' + Date.now())
      .digest('hex')
      .slice(0, 32);
    
    // Create Baileys-compatible browser tuple
    // Format: [clientName, browserName, versionString]
    const browser = [
      `${browserName}`, // e.g., "Chrome"
      platformString,    // e.g., "Windows 10"
      chromeVersion      // e.g., "131.0.6778.139"
    ];
    
    return {
      browser,
      deviceId,
      platform: selectedPlatform.os,
      chromeVersion,
      createdAt: new Date().toISOString(),
      schemaVersion: AUTH_SCHEMA_VERSION
    };
  }
  
  /**
   * Remove fingerprint for an account (on logout/delete)
   */
  async removeFingerprint(accountId) {
    await this.load();
    
    if (this.registry.has(accountId)) {
      this.registry.delete(accountId);
      await this.save();
      logger.info(`[DeviceFP] Removed fingerprint for ${accountId}`);
    }
  }
  
  /**
   * Update browser version for an account (simulate browser update)
   * Call this occasionally to simulate natural browser updates
   */
  async simulateBrowserUpdate(accountId) {
    await this.load();
    
    const current = this.registry.get(accountId);
    if (!current) return null;
    
    // Only update if Chrome version is more than 2 major versions behind
    const currentMajor = parseInt(current.chromeVersion.split('.')[0]);
    const latestVersions = DEVICE_POOLS.chromeVersions.filter(v => 
      parseInt(v.split('.')[0]) > currentMajor
    );
    
    if (latestVersions.length > 2) {
      // Pick a newer version (not the very latest - that's suspicious)
      const newIndex = Math.floor(Math.random() * Math.min(latestVersions.length - 2, 5));
      const newVersion = latestVersions[newIndex];
      
      current.chromeVersion = newVersion;
      current.browser[2] = newVersion;
      current.lastUpdated = new Date().toISOString();
      
      await this.save();
      logger.info(`[DeviceFP] Simulated browser update for ${accountId}: ${currentMajor} → ${newVersion.split('.')[0]}`);
      
      return current;
    }
    
    return current;
  }
}

// Singleton instance
const deviceFingerprintManager = new DeviceFingerprintManager();

// ============================================================================
// AUTH STATE MANAGER
// ============================================================================

class AuthStateManager {
  constructor() {
    this.states = new Map(); // accountId -> { creds, keys, dirty, lastSave }
    this.saveLocks = new Map(); // accountId -> Promise (prevent concurrent saves)
    this.saveQueue = new Map(); // accountId -> timeout (debounced saves)
  }
  
  /**
   * Get the session path for an account
   */
  getSessionPath(accountId) {
    return path.join(AUTH_ROOT, `session_${accountId}`);
  }
  
  /**
   * Check if a valid session exists for an account
   */
  async sessionExists(accountId) {
    const sessionPath = this.getSessionPath(accountId);
    const credsPath = path.join(sessionPath, 'creds.json');
    
    try {
      await fs.access(credsPath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Create auth state for Baileys
   * Implements proper atomic saves and corruption recovery
   */
  async createAuthState(accountId, db = null) {
    const sessionPath = this.getSessionPath(accountId);
    
    // Ensure session directory exists
    await fs.mkdir(sessionPath, { recursive: true });
    
    // Helper to read JSON files safely
    const readData = async (file) => {
      const filePath = path.join(sessionPath, `${this._fixFileName(file)}.json`);
      
      try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data, BufferJSON.reviver);
      } catch (error) {
        // Try backup file
        const backupPath = filePath + '.bak';
        try {
          const backupData = await fs.readFile(backupPath, 'utf8');
          logger.warn(`[AuthState] Recovered ${file} from backup for ${accountId}`);
          return JSON.parse(backupData, BufferJSON.reviver);
        } catch {
          return null;
        }
      }
    };
    
    // Helper to write JSON files atomically
    const writeData = async (file, data) => {
      const filePath = path.join(sessionPath, `${this._fixFileName(file)}.json`);
      const tempPath = filePath + '.tmp';
      const backupPath = filePath + '.bak';
      
      const serialized = JSON.stringify(data, BufferJSON.replacer, 2);
      
      try {
        // Write to temp file first
        await fs.writeFile(tempPath, serialized);
        
        // Backup existing file if it exists
        try {
          await fs.copyFile(filePath, backupPath);
        } catch {} // Ignore if doesn't exist
        
        // Atomic rename
        await fs.rename(tempPath, filePath);
      } catch (error) {
        logger.error(`[AuthState] Failed to write ${file}: ${error.message}`);
        // Cleanup temp file
        try { await fs.unlink(tempPath); } catch {}
        throw error;
      }
    };
    
    // Helper to remove data
    const removeData = async (file) => {
      const filePath = path.join(sessionPath, `${this._fixFileName(file)}.json`);
      try {
        await fs.unlink(filePath);
        try { await fs.unlink(filePath + '.bak'); } catch {}
      } catch {}
    };
    
    // Try to restore from database first (if available)
    if (db && typeof db.getAccountAuthState === 'function') {
      try {
        const dbState = await db.getAccountAuthState(accountId);
        if (dbState?.creds) {
          logger.info(`[AuthState] Restoring session for ${accountId} from database`);
          
          // Write database state to local files
          await writeData('creds', dbState.creds);
          if (dbState.keys) {
            for (const [keyType, keyData] of Object.entries(dbState.keys)) {
              await writeData(keyType, keyData);
            }
          }
        }
      } catch (error) {
        logger.warn(`[AuthState] DB restore failed for ${accountId}: ${error.message}`);
      }
    }
    
    // Load or create credentials
    let creds = await readData('creds');
    if (!creds) {
      creds = initAuthCreds();
      await writeData('creds', creds);
      logger.info(`[AuthState] Created new credentials for ${accountId}`);
    }
    
    // Track state for this account
    this.states.set(accountId, {
      creds,
      sessionPath,
      dirty: false,
      lastSave: Date.now(),
      saveCount: 0
    });
    
    // Create saveCreds function with debouncing
    const saveCreds = async () => {
      const state = this.states.get(accountId);
      if (!state) return;
      
      // Debounce saves - wait 500ms for additional changes
      return new Promise((resolve) => {
        if (this.saveQueue.has(accountId)) {
          clearTimeout(this.saveQueue.get(accountId));
        }
        
        this.saveQueue.set(accountId, setTimeout(async () => {
          this.saveQueue.delete(accountId);
          
          // Acquire save lock
          const existingLock = this.saveLocks.get(accountId);
          if (existingLock) {
            await existingLock;
          }
          
          const saveLock = (async () => {
            try {
              await writeData('creds', state.creds);
              state.lastSave = Date.now();
              state.saveCount++;
              state.dirty = false;
              
              // Sync to database periodically (every 10 saves)
              if (db && state.saveCount % 10 === 0) {
                this._syncToDatabase(accountId, db).catch(e => 
                  logger.warn(`[AuthState] DB sync failed: ${e.message}`)
                );
              }
              
              logger.debug(`[AuthState] Saved creds for ${accountId} (save #${state.saveCount})`);
            } catch (error) {
              logger.error(`[AuthState] Save failed for ${accountId}: ${error.message}`);
            }
          })();
          
          this.saveLocks.set(accountId, saveLock);
          await saveLock;
          this.saveLocks.delete(accountId);
          
          resolve();
        }, 500));
      });
    };
    
    // Create keys interface with proper caching
    const keys = {
      get: async (type, ids) => {
        const data = {};
        
        for (const id of ids) {
          const keyData = await readData(`${type}-${id}`);
          if (keyData) {
            data[id] = keyData;
          }
        }
        
        return data;
      },
      
      set: async (data) => {
        for (const [category, categoryData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(categoryData)) {
            if (value) {
              await writeData(`${category}-${id}`, value);
            } else {
              await removeData(`${category}-${id}`);
            }
          }
        }
      }
    };
    
    return {
      state: { creds, keys },
      saveCreds,
      sessionPath
    };
  }
  
  /**
   * Fix file name for cross-platform compatibility
   */
  _fixFileName(file) {
    if (!file) return undefined;
    return file.replace(/\//g, '__').replace(/:/g, '-');
  }
  
  /**
   * Sync auth state to database
   */
  async _syncToDatabase(accountId, db) {
    const state = this.states.get(accountId);
    if (!state) return;
    
    try {
      // Read all key files
      const sessionPath = state.sessionPath;
      const files = await fs.readdir(sessionPath);
      const keys = {};
      
      for (const file of files) {
        if (file.endsWith('.json') && !file.includes('.tmp') && !file.includes('.bak')) {
          const keyName = file.replace('.json', '');
          if (keyName !== 'creds') {
            try {
              const data = await fs.readFile(path.join(sessionPath, file), 'utf8');
              keys[keyName] = JSON.parse(data, BufferJSON.reviver);
            } catch {}
          }
        }
      }
      
      // Save to database
      if (typeof db.saveAccountAuthState === 'function') {
        await db.saveAccountAuthState(accountId, {
          creds: state.creds,
          keys,
          schemaVersion: AUTH_SCHEMA_VERSION,
          lastSync: new Date().toISOString()
        });
        
        logger.info(`[AuthState] Synced ${accountId} to database (${Object.keys(keys).length} keys)`);
      }
    } catch (error) {
      logger.error(`[AuthState] Database sync failed for ${accountId}: ${error.message}`);
    }
  }
  
  /**
   * Force sync to database (call on disconnect/shutdown)
   */
  async forceSync(accountId, db) {
    // Wait for any pending saves
    const existingLock = this.saveLocks.get(accountId);
    if (existingLock) await existingLock;
    
    // Clear any pending debounced saves
    if (this.saveQueue.has(accountId)) {
      clearTimeout(this.saveQueue.get(accountId));
      this.saveQueue.delete(accountId);
    }
    
    await this._syncToDatabase(accountId, db);
  }
  
  /**
   * Clear session for an account
   */
  async clearSession(accountId) {
    const sessionPath = this.getSessionPath(accountId);
    
    try {
      // Remove from state tracking
      this.states.delete(accountId);
      
      // Remove files
      const files = await fs.readdir(sessionPath);
      for (const file of files) {
        await fs.unlink(path.join(sessionPath, file));
      }
      await fs.rmdir(sessionPath);
      
      // Remove fingerprint
      await deviceFingerprintManager.removeFingerprint(accountId);
      
      logger.info(`[AuthState] Cleared session for ${accountId}`);
    } catch (error) {
      logger.warn(`[AuthState] Clear session failed for ${accountId}: ${error.message}`);
    }
  }
  
  /**
   * Get session info (for debugging)
   */
  getSessionInfo(accountId) {
    const state = this.states.get(accountId);
    if (!state) return null;
    
    return {
      hasSession: true,
      saveCount: state.saveCount,
      lastSave: state.lastSave,
      dirty: state.dirty,
      sessionPath: state.sessionPath
    };
  }
}

// Singleton instance
const authStateManager = new AuthStateManager();

// ============================================================================
// HUMAN BEHAVIOR SIMULATOR
// ============================================================================

class HumanBehaviorSimulator {
  constructor() {
    this.activityTimestamps = new Map(); // accountId -> last activity time
    this.typingStates = new Map(); // accountId -> { targetJid, startTime }
  }
  
  /**
   * Generate random delay within range
   */
  randomDelay(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }
  
  /**
   * Wait with random jitter (prevents pattern detection)
   */
  async waitWithJitter(baseMs, jitterRatio = 0.3) {
    const jitter = baseMs * jitterRatio * (Math.random() - 0.5) * 2;
    const delay = Math.max(100, baseMs + jitter);
    await new Promise(resolve => setTimeout(resolve, delay));
    return delay;
  }
  
  /**
   * Simulate human typing delay
   * Longer messages = more typing time
   */
  async simulateTypingDelay(messageLength) {
    // Average typing speed: 40-60 WPM
    // That's ~3-5 characters per second
    const charDelay = this.randomDelay(TIMING.typingMinMs, TIMING.typingMaxMs);
    const totalDelay = Math.min(
      messageLength * charDelay,
      30000 // Max 30 seconds typing time
    );
    
    // Add some random pauses (thinking time)
    const pauseCount = Math.floor(messageLength / 50); // Pause every ~50 chars
    const pauseTime = pauseCount * this.randomDelay(500, 1500);
    
    await new Promise(resolve => setTimeout(resolve, totalDelay + pauseTime));
  }
  
  /**
   * Simulate presence update with realistic delay
   */
  async simulatePresenceDelay() {
    const delay = this.randomDelay(TIMING.presenceDelayMinMs, TIMING.presenceDelayMaxMs);
    await new Promise(resolve => setTimeout(resolve, delay));
    return delay;
  }
  
  /**
   * Get exponential backoff delay for reconnection
   * With jitter to prevent thundering herd
   */
  getReconnectDelay(attemptNumber) {
    // Exponential backoff: 5s, 10s, 20s, 40s, 80s... capped at 5min
    const exponentialDelay = Math.min(
      TIMING.reconnectBaseMs * Math.pow(2, attemptNumber),
      TIMING.reconnectMaxMs
    );
    
    // Add jitter (±30%)
    const jitter = exponentialDelay * TIMING.reconnectJitterRatio * (Math.random() - 0.5) * 2;
    
    return Math.max(TIMING.reconnectBaseMs, exponentialDelay + jitter);
  }
  
  /**
   * Check if account is in "active hours"
   * Returns true if current time matches typical human activity patterns
   */
  isActiveHours(timezone = 'UTC') {
    const now = new Date();
    const hour = now.getUTCHours(); // You might adjust for timezone
    
    // Active hours: 7 AM - 11 PM (allow some late night)
    return hour >= 7 && hour <= 23;
  }
  
  /**
   * Record activity timestamp
   */
  recordActivity(accountId) {
    this.activityTimestamps.set(accountId, Date.now());
  }
  
  /**
   * Get time since last activity
   */
  getIdleTime(accountId) {
    const lastActivity = this.activityTimestamps.get(accountId);
    return lastActivity ? Date.now() - lastActivity : Infinity;
  }
  
  /**
   * Determine if we should go offline (simulate human leaving)
   * Returns true if idle for too long
   */
  shouldGoOffline(accountId) {
    const idleTime = this.getIdleTime(accountId);
    const maxIdleTime = 30 * 60 * 1000; // 30 minutes
    
    return idleTime > maxIdleTime;
  }
  
  /**
   * Get next heartbeat interval
   * Randomized to prevent detection
   */
  getHeartbeatInterval() {
    return this.randomDelay(TIMING.heartbeatMinMs, TIMING.heartbeatMaxMs);
  }
}

// Singleton instance
const humanBehaviorSimulator = new HumanBehaviorSimulator();

// ============================================================================
// SESSION VALIDATOR
// ============================================================================

class SessionValidator {
  constructor() {
    this.validationCache = new Map(); // accountId -> { valid, checkedAt }
    this.cacheTTL = 60000; // 1 minute cache
  }
  
  /**
   * Validate session integrity
   * Checks if all required files exist and are valid
   */
  async validateSession(accountId) {
    const cached = this.validationCache.get(accountId);
    if (cached && Date.now() - cached.checkedAt < this.cacheTTL) {
      return cached.valid;
    }
    
    const sessionPath = authStateManager.getSessionPath(accountId);
    const credsPath = path.join(sessionPath, 'creds.json');
    
    let valid = false;
    let issues = [];
    
    try {
      // Check creds file exists
      await fs.access(credsPath);
      
      // Check creds is valid JSON
      const credsData = await fs.readFile(credsPath, 'utf8');
      const creds = JSON.parse(credsData, BufferJSON.reviver);
      
      // Check required fields
      if (!creds.me && !creds.noiseKey && !creds.signedIdentityKey) {
        // No registration yet - still valid for new connection
        valid = true;
      } else if (creds.me?.id) {
        // Has registered identity
        valid = true;
        
        // Additional checks for registered session
        if (!creds.noiseKey) issues.push('missing noiseKey');
        if (!creds.signedIdentityKey) issues.push('missing signedIdentityKey');
        if (!creds.registrationId) issues.push('missing registrationId');
      } else {
        valid = true; // New session
      }
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        // No session - valid for new connection
        valid = true;
      } else {
        issues.push(error.message);
        valid = false;
      }
    }
    
    if (issues.length > 0) {
      logger.warn(`[SessionValidator] Issues for ${accountId}: ${issues.join(', ')}`);
    }
    
    this.validationCache.set(accountId, { valid, checkedAt: Date.now() });
    return valid;
  }
  
  /**
   * Check if session is registered (has completed pairing)
   */
  async isRegistered(accountId) {
    const sessionPath = authStateManager.getSessionPath(accountId);
    const credsPath = path.join(sessionPath, 'creds.json');
    
    try {
      const credsData = await fs.readFile(credsPath, 'utf8');
      const creds = JSON.parse(credsData, BufferJSON.reviver);
      return !!(creds.me?.id);
    } catch {
      return false;
    }
  }
  
  /**
   * Clear validation cache for an account
   */
  invalidateCache(accountId) {
    this.validationCache.delete(accountId);
  }
}

// Singleton instance
const sessionValidator = new SessionValidator();

// ============================================================================
// CONNECTION QUALITY MONITOR
// ============================================================================

class ConnectionQualityMonitor {
  constructor() {
    this.metrics = new Map(); // accountId -> { disconnects, latency, errors }
    this.blacklistPeriods = new Map(); // accountId -> cooldown end time
  }
  
  /**
   * Record a disconnect event
   */
  recordDisconnect(accountId, reason) {
    const metric = this.metrics.get(accountId) || {
      disconnects: [],
      errors: [],
      consecutiveFailures: 0
    };
    
    metric.disconnects.push({
      timestamp: Date.now(),
      reason
    });
    
    // Keep last 24 hours only
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    metric.disconnects = metric.disconnects.filter(d => d.timestamp > dayAgo);
    
    metric.consecutiveFailures++;
    
    this.metrics.set(accountId, metric);
    
    // Check if we need to blacklist (too many disconnects)
    if (metric.disconnects.length >= 10) {
      this._checkBlacklist(accountId, metric);
    }
  }
  
  /**
   * Record successful connection
   */
  recordSuccess(accountId) {
    const metric = this.metrics.get(accountId) || {
      disconnects: [],
      errors: [],
      consecutiveFailures: 0
    };
    
    metric.consecutiveFailures = 0;
    metric.lastSuccess = Date.now();
    
    this.metrics.set(accountId, metric);
  }
  
  /**
   * Check if account should be blacklisted
   */
  _checkBlacklist(accountId, metric) {
    const recentDisconnects = metric.disconnects.filter(
      d => Date.now() - d.timestamp < 30 * 60 * 1000 // Last 30 minutes
    );
    
    // If more than 5 disconnects in 30 minutes, cooldown
    if (recentDisconnects.length >= 5) {
      const cooldownMs = 30 * 60 * 1000; // 30 minute cooldown
      this.blacklistPeriods.set(accountId, Date.now() + cooldownMs);
      logger.warn(`[ConnectionQuality] Account ${accountId} entering ${cooldownMs/60000}min cooldown (${recentDisconnects.length} recent disconnects)`);
    }
  }
  
  /**
   * Check if account is in cooldown
   */
  isInCooldown(accountId) {
    const cooldownEnd = this.blacklistPeriods.get(accountId);
    if (cooldownEnd && Date.now() < cooldownEnd) {
      return {
        inCooldown: true,
        remainingMs: cooldownEnd - Date.now()
      };
    }
    return { inCooldown: false };
  }
  
  /**
   * Get recommended reconnect delay based on history
   */
  getRecommendedDelay(accountId) {
    const metric = this.metrics.get(accountId);
    if (!metric) return TIMING.reconnectBaseMs;
    
    // Base delay on consecutive failures
    return humanBehaviorSimulator.getReconnectDelay(metric.consecutiveFailures);
  }
  
  /**
   * Get connection quality score (0-100)
   */
  getQualityScore(accountId) {
    const metric = this.metrics.get(accountId);
    if (!metric) return 100;
    
    // Penalize recent disconnects
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recentDisconnects = metric.disconnects.filter(d => d.timestamp > hourAgo).length;
    
    // Score = 100 - (disconnects * 10), min 0
    return Math.max(0, 100 - recentDisconnects * 10);
  }
}

// Singleton instance
const connectionQualityMonitor = new ConnectionQualityMonitor();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  AUTH_SCHEMA_VERSION,
  TIMING,
  
  // Managers
  deviceFingerprintManager,
  authStateManager,
  humanBehaviorSimulator,
  sessionValidator,
  connectionQualityMonitor,
  
  // Classes (for testing/extension)
  DeviceFingerprintManager,
  AuthStateManager,
  HumanBehaviorSimulator,
  SessionValidator,
  ConnectionQualityMonitor
};
