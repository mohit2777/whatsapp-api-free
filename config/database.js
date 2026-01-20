const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Missing Supabase configuration. Please check your .env file.');
  process.exit(1);
}

// Create optimized Supabase client with enhanced configuration
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false
  },
  db: {
    schema: 'public'
  },
  global: {
    headers: {
      'x-application-name': 'wa-multi-automation-v2'
    }
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

// Enhanced in-memory cache with TTL and size limits
class CacheManager {
  constructor(maxSize = 1000, defaultTTL = 60000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.stats = { hits: 0, misses: 0 };
  }

  set(key, value, ttl = this.defaultTTL) {
    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl
    });
  }

  get(key) {
    const item = this.cache.get(key);

    if (!item) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return item.value;
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  invalidatePattern(pattern) {
    const regex = new RegExp(pattern);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }
}

const cacheManager = new CacheManager(
  parseInt(process.env.QUERY_CACHE_SIZE) || 1000,
  parseInt(process.env.CACHE_TTL) || 300000  // 5 minutes default cache
);

/**
 * Retry helper for database operations with exponential backoff
 * Handles temporary Supabase 5xx errors gracefully
 */
async function withRetry(fn, operationName, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if it's a retryable error (5xx, network issues)
      const isRetryable =
        error?.code === 'PGRST500' ||
        error?.code === 'PGRST520' ||
        error?.message?.includes('520') ||
        error?.message?.includes('502') ||
        error?.message?.includes('503') ||
        error?.message?.includes('504') ||
        error?.message?.includes('fetch failed') ||
        error?.message?.includes('network') ||
        error?.message?.includes('ECONNRESET') ||
        error?.message?.includes('ETIMEDOUT');

      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }

      const delay = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
      logger.warn(`[DB Retry] ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// Database helper functions with improved error handling
class MissingWebhookQueueTableError extends Error {
  constructor(message) {
    super(message || 'webhook_delivery_queue table not found');
    this.name = 'MissingWebhookQueueTableError';
  }
}

function isWebhookQueueMissingError(error) {
  return error?.code === 'PGRST205' && /webhook_delivery_queue/i.test(error?.message || '');
}

// Generate a random API key
function generateApiKey() {
  const crypto = require('crypto');
  return 'wak_' + crypto.randomBytes(24).toString('hex'); // wak_ prefix + 48 hex chars = 52 total
}

const db = {
  // Account management
  async createAccount(accountData) {
    try {
      // Generate API key for new account
      const dataWithApiKey = {
        ...accountData,
        api_key: generateApiKey()
      };

      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .insert([dataWithApiKey])
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      // Invalidate accounts cache
      cacheManager.invalidatePattern('^accounts');

      logger.info(`Account created: ${accountData.id}`);
      return data[0];
    } catch (error) {
      logger.error('Error creating account:', error);
      throw error;
    }
  },

  async getAccounts() {
    const cacheKey = 'accounts_all';
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    return withRetry(async () => {
      // Explicitly select columns WITHOUT session_data (which is huge - 1-5MB each)
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('id, name, description, phone_number, status, metadata, created_at, updated_at')
        .order('created_at', { ascending: false });

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      const accounts = data || [];
      cacheManager.set(cacheKey, accounts);

      return accounts;
    }, 'getAccounts');
  },

  async getAccount(id) {
    const cacheKey = `account_${id}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Exclude session_data to avoid huge payloads
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('id, name, description, phone_number, status, metadata, created_at, updated_at')
        .eq('id', id)
        .single();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      cacheManager.set(cacheKey, data);
      return data;
    } catch (error) {
      logger.error(`Error fetching account ${id}:`, error);
      throw error;
    }
  },

  // Get account by API key (for API authentication) - with caching
  async getAccountByApiKey(apiKey) {
    if (!apiKey) return null;
    
    // Check cache first
    const cacheKey = `api_key_${apiKey}`;
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      return cached;
    }
    
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('id, name, phone_number, status')
        .eq('api_key', apiKey)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // No rows found
        throw error;
      }

      // Cache for 5 minutes (API keys don't change often)
      if (data) {
        cacheManager.set(cacheKey, data, 5 * 60 * 1000);
      }

      return data;
    } catch (error) {
      logger.error('Error fetching account by API key:', error);
      return null;
    }
  },

  // Regenerate API key for an account
  async regenerateApiKey(accountId) {
    const newApiKey = generateApiKey();
    
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .update({ api_key: newApiKey, updated_at: new Date().toISOString() })
      .eq('id', accountId)
      .select('api_key');

    if (error) throw error;
    
    // Invalidate caches (including API key cache)
    cacheManager.invalidate(`account_${accountId}`);
    cacheManager.invalidatePattern('^accounts');
    cacheManager.invalidatePattern('^api_key_');
    
    return data[0]?.api_key;
  },

  // Get API key for an account (for dashboard display)
  async getApiKey(accountId) {
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .select('api_key')
      .eq('id', accountId)
      .single();

    if (error) return null;
    return data?.api_key;
  },

  async updateAccount(id, updates) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .update(updates)
        .eq('id', id)
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      // Invalidate related caches
      cacheManager.invalidate(`account_${id}`);
      cacheManager.invalidatePattern('^accounts');

      logger.debug(`Account updated: ${id}`);
      return data[0];
    }, `updateAccount(${id})`);
  },

  async deleteAccount(id) {
    try {
      const { error } = await supabase
        .from('whatsapp_accounts')
        .delete()
        .eq('id', id);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      // Invalidate related caches
      cacheManager.invalidate(`account_${id}`);
      cacheManager.invalidatePattern('^accounts');
      cacheManager.invalidatePattern(`^webhooks_${id}`);
      cacheManager.invalidatePattern(`^messages_${id}`);

      logger.info(`Account deleted: ${id}`);
      return true;
    } catch (error) {
      logger.error(`Error deleting account ${id}:`, error);
      throw error;
    }
  },

  // Session Management
  async getSessionData(accountId) {
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('session_data')
        .eq('id', accountId)
        .single();

      if (error) return null;
      return data?.session_data || null;
    } catch (error) {
      logger.error(`Error fetching session data for ${accountId}:`, error);
      return null;
    }
  },

  async saveSessionData(accountId, sessionData) {
    try {
      const { error } = await supabase
        .from('whatsapp_accounts')
        .update({
          session_data: sessionData,
          last_session_saved: new Date().toISOString()
        })
        .eq('id', accountId);

      if (error) throw error;
      return true;
    } catch (error) {
      logger.error(`Error saving session data for ${accountId}:`, error);
      throw error;
    }
  },

  async clearSessionData(accountId) {
    try {
      const { error } = await supabase
        .from('whatsapp_accounts')
        .update({
          session_data: null,
          last_session_saved: null
        })
        .eq('id', accountId);

      if (error) throw error;
      return true;
    } catch (error) {
      logger.error(`Error clearing session data for ${accountId}:`, error);
      throw error;
    }
  },

  // Webhook management
  async createWebhook(webhookData) {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .insert([webhookData])
        .select();

      if (error) throw error;

      // Invalidate webhooks cache for this account
      cacheManager.invalidate(`webhooks_${webhookData.account_id}`);

      logger.info(`Webhook created: ${webhookData.id} for account ${webhookData.account_id}`);
      return data[0];
    } catch (error) {
      logger.error('Error creating webhook:', error);
      throw error;
    }
  },

  // Get all webhooks (for dashboard indicators)
  async getAllWebhooks() {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('id, account_id, is_active');

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching all webhooks:', error);
      return [];
    }
  },

  async getWebhooks(accountId) {
    const cacheKey = `webhooks_${accountId}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const webhooks = data || [];
      cacheManager.set(cacheKey, webhooks);

      return webhooks;
    } catch (error) {
      logger.error(`Error fetching webhooks for account ${accountId}:`, error);
      throw error;
    }
  },

  async getWebhook(id) {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error(`Error fetching webhook ${id}:`, error);
      throw error;
    }
  },

  async updateWebhook(id, updates) {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .update(updates)
        .eq('id', id)
        .select();

      if (error) throw error;

      // Invalidate cache
      if (data && data[0]) {
        cacheManager.invalidate(`webhooks_${data[0].account_id}`);
      }

      logger.debug(`Webhook updated: ${id}`);
      return data[0];
    } catch (error) {
      logger.error(`Error updating webhook ${id}:`, error);
      throw error;
    }
  },

  async deleteWebhook(id) {
    try {
      // Get webhook info before deleting
      let webhookAccountId = null;
      try {
        const { data: existing } = await supabase
          .from('webhooks')
          .select('id, account_id')
          .eq('id', id)
          .single();
        webhookAccountId = existing?.account_id || null;
      } catch (_) { }

      // Delete the webhook
      const { error } = await supabase
        .from('webhooks')
        .delete()
        .eq('id', id);

      if (error) throw error;

      // Invalidate cache
      if (webhookAccountId) {
        cacheManager.invalidate(`webhooks_${webhookAccountId}`);
      }

      logger.info(`Webhook deleted: ${id}`);
      return true;
    } catch (error) {
      logger.error(`Error deleting webhook ${id}:`, error);
      throw error;
    }
  },

  // Message logging removed - messages are forwarded to n8n via webhooks
  // Stub methods for backwards compatibility
  async logMessage(messageData) {
    // No-op: messages are sent to webhooks only
    return messageData;
  },

  // Get queue status (stub - no queue anymore)
  getQueueStatus() {
    return {
      queueSize: 0,
      processing: false,
      lastFlush: Date.now()
    };
  },

  // Get cache stats
  getCacheStats() {
    return cacheManager.getStats();
  },

  // Clear cache
  clearCache() {
    cacheManager.clear();
    logger.info('Cache cleared');
  },

  // ============================================================================
  // AI Auto Reply Configuration (per account)
  // ============================================================================

  // Get all AI configs (for dashboard indicators)
  async getAllAiConfigs() {
    try {
      const { data, error } = await supabase
        .from('ai_auto_replies')
        .select('account_id, is_active, provider');

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching all AI configs:', error);
      return [];
    }
  },

  async getAiConfig(accountId) {
    try {
      // Try cache first
      const cacheKey = `ai_config_${accountId}`;
      const cached = cacheManager.get(cacheKey);
      if (cached) return cached;

      const { data, error } = await supabase
        .from('ai_auto_replies')
        .select('*')
        .eq('account_id', accountId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return null; // no config yet
        }
        throw error;
      }

      // Cache the result (5 minutes)
      if (data) {
        cacheManager.set(cacheKey, data, 300000);
      }

      return data;
    } catch (error) {
      logger.error(`Error fetching AI config for ${accountId}:`, error);
      return null;
    }
  },

  // Backwards-compatible alias used by older chatbot manager code
  async getChatbotConfig(accountId) {
    return await this.getAiConfig(accountId);
  },

  async saveAiConfig(config) {
    try {
      const { data, error } = await supabase
        .from('ai_auto_replies')
        .upsert(config, { onConflict: 'account_id' })
        .select();

      if (error) throw error;

      // Invalidate cache
      if (config.account_id) {
        cacheManager.invalidate(`ai_config_${config.account_id}`);
      }

      return data?.[0] || null;
    } catch (error) {
      logger.error('Error saving AI config:', error);
      throw error;
    }
  },

  async deleteAiConfig(accountId) {
    try {
      const { error } = await supabase
        .from('ai_auto_replies')
        .delete()
        .eq('account_id', accountId);

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`ai_config_${accountId}`);

      return true;
    } catch (error) {
      logger.error(`Error deleting AI config for ${accountId}:`, error);
      throw error;
    }
  },

  // ============================================================================
  // Session Management (for persistent WhatsApp authentication)
  // ============================================================================

  /**
   * Save WhatsApp session data to database
   * @param {string} accountId - Account UUID
   * @param {string} sessionData - Base64 encoded session data
   */
  async saveSessionData(accountId, sessionData) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .update({
          session_data: sessionData,
          last_session_saved: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', accountId)
        .select();

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`account_${accountId}`);
      cacheManager.invalidatePattern('^accounts');

      return data[0];
    }, `saveSessionData(${accountId})`);
  },

  /**
   * Get WhatsApp session data from database
   * @param {string} accountId - Account UUID
   * @returns {string|null} Base64 encoded session data or null
   */
  async getSessionData(accountId) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('session_data')
        .eq('id', accountId)
        .single();

      if (error) throw error;

      return data?.session_data || null;
    }, `getSessionData(${accountId})`).catch(error => {
      logger.error(`Error fetching session data for ${accountId}:`, error);
      return null;
    });
  },

  /**
   * Clear WhatsApp session data from database (logout)
   * @param {string} accountId - Account UUID
   */
  async clearSessionData(accountId) {
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .update({
          session_data: null,
          last_session_saved: null,
          status: 'disconnected',
          updated_at: new Date().toISOString()
        })
        .eq('id', accountId)
        .select();

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`account_${accountId}`);
      cacheManager.invalidatePattern('^accounts');

      logger.info(`Session data cleared for account: ${accountId}`);
      return data[0];
    } catch (error) {
      logger.error(`Error clearing session data for ${accountId}:`, error);
      throw error;
    }
  },

  /**
   * Check if account has saved session
   * @param {string} accountId - Account UUID
   * @returns {boolean}
   */
  async hasSessionData(accountId) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('session_data, last_session_saved')
        .eq('id', accountId)
        .single();

      if (error) throw error;

      const hasData = !!(data?.session_data);
      const sessionSize = data?.session_data ? data.session_data.length : 0;
      
      logger.debug(`hasSessionData(${accountId}): hasData=${hasData}, size=${sessionSize}, lastSaved=${data?.last_session_saved}`);
      
      return hasData;
    }, `hasSessionData(${accountId})`).catch(error => {
      logger.error(`Error checking session data for ${accountId}:`, error);
      return false;
    });
  },

  // ============================================================================
  // Webhook Delivery Queue (durable retries)
  // ============================================================================

  async enqueueWebhookDelivery({ accountId, webhook, payload, maxRetries }) {
    try {
      const record = {
        account_id: accountId,
        webhook_id: webhook.id,
        webhook_url: webhook.url,
        webhook_secret: webhook.secret || null,
        payload,
        max_retries: maxRetries,
        status: 'pending',
        next_attempt_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('webhook_delivery_queue')
        .insert([record])
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      return data?.[0] || null;
    } catch (error) {
      logger.error('Error enqueuing webhook delivery:', error);
      throw error;
    }
  },

  async getDueWebhookDeliveries(limit = 10) {
    try {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('webhook_delivery_queue')
        .select('*')
        .in('status', ['pending', 'failed'])
        .lte('next_attempt_at', now)
        .order('next_attempt_at', { ascending: true })
        .limit(limit);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return data || [];
    } catch (error) {
      logger.error('Error fetching due webhook deliveries:', error);
      return [];
    }
  },

  async markWebhookDeliveryProcessing(job) {
    try {
      const { data, error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: 'processing',
          attempt_count: job.attempt_count + 1,
          last_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', job.id)
        .in('status', ['pending', 'failed'])
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return data?.[0] || null;
    } catch (error) {
      logger.error(`Error marking webhook delivery ${job.id} processing:`, error);
      return null;
    }
  },

  async completeWebhookDelivery(jobId, responseStatus) {
    try {
      const { error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: 'success',
          response_status: responseStatus,
          last_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return true;
    } catch (error) {
      logger.error(`Error completing webhook delivery ${jobId}:`, error);
      return false;
    }
  },

  async failWebhookDelivery(job, errorMessage, nextAttemptAt, isDeadLetter = false) {
    try {
      const { error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: isDeadLetter ? 'dead_letter' : 'failed',
          last_error: errorMessage,
          next_attempt_at: nextAttemptAt,
          updated_at: new Date().toISOString()
        })
        .eq('id', job.id);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return true;
    } catch (error) {
      logger.error(`Error failing webhook delivery ${job.id}:`, error);
      return false;
    }
  },

  async resetStuckWebhookDeliveries(minutes = 5) {
    try {
      const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
      const { error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: 'failed',
          next_attempt_at: new Date().toISOString(),
          last_error: 'Recovered from unexpected shutdown'
        })
        .eq('status', 'processing')
        .lte('updated_at', cutoff);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
    } catch (error) {
      logger.error('Error resetting stuck webhook deliveries:', error);
      throw error;
    }
  },

  async getWebhookQueueStats() {
    const statuses = ['pending', 'processing', 'failed', 'dead_letter'];
    const stats = {};

    for (const status of statuses) {
      try {
        const { count, error } = await supabase
          .from('webhook_delivery_queue')
          .select('id', { count: 'exact', head: true })
          .eq('status', status);

        if (error) {
          if (isWebhookQueueMissingError(error)) {
            throw new MissingWebhookQueueTableError();
          }
          throw error;
        }
        stats[status] = count || 0;
      } catch (error) {
        if (error instanceof MissingWebhookQueueTableError) {
          throw error;
        }
        logger.error(`Error counting webhook queue status ${status}:`, error);
        stats[status] = 0;
      }
    }

    return stats;
  },

  // Get all accounts stats in a single query (avoids N+1 problem)
  async getAllAccountsStats() {
    const cacheKey = 'all_accounts_stats';
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Try to use the optimized PostgreSQL function
      const { data, error } = await supabase.rpc('get_all_accounts_stats');

      if (error) {
        // Fallback: the function might not exist yet
        logger.warn('get_all_accounts_stats function not available, using fallback');
        return null;
      }

      // Convert to a map for easy lookup
      const statsMap = {};
      data.forEach(row => {
        statsMap[row.account_id] = {
          total: parseInt(row.total) || 0,
          incoming: parseInt(row.incoming) || 0,
          outgoing: parseInt(row.outgoing) || 0,
          success: parseInt(row.success) || 0,
          failed: parseInt(row.failed) || 0,
          outgoing_success: parseInt(row.outgoing_success) || 0
        };
      });

      cacheManager.set(cacheKey, statsMap, 60000); // Cache for 1 minute
      return statsMap;
    } catch (error) {
      logger.error('Error fetching all accounts stats:', error);
      return null;
    }
  },

  // ============================================================================
  // ACCOUNT NUMBER SETTINGS (with caching for speed)
  // ============================================================================

  // Get number settings - uses cache for fast lookups
  async getNumberSettings(accountId, phoneNumber) {
    try {
      // Normalize phone number (remove non-digits)
      const normalizedPhone = phoneNumber.replace(/\D/g, '');
      const cacheKey = `number_settings:${accountId}:${normalizedPhone}`;

      // Check cache first
      const cached = cacheManager.get(cacheKey);
      if (cached !== null) {
        return cached;
      }

      // Query database
      const { data, error } = await supabase
        .from('account_number_settings')
        .select('*')
        .eq('account_id', accountId)
        .eq('phone_number', normalizedPhone)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        throw error;
      }

      // Default settings if not found (all enabled)
      const settings = data || {
        webhook_enabled: true,
        chatbot_enabled: true,
        flow_enabled: true
      };

      // Cache for 5 minutes
      cacheManager.set(cacheKey, settings, 300000);

      return settings;
    } catch (error) {
      logger.error('Error getting number settings:', error);
      // Return defaults on error (don't block processing)
      return { webhook_enabled: true, chatbot_enabled: true, flow_enabled: true };
    }
  },

  // Get all number settings for an account
  async getAllNumberSettings(accountId) {
    try {
      const { data, error } = await supabase
        .from('account_number_settings')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error getting all number settings:', error);
      return [];
    }
  },

  // Add or update number settings
  async upsertNumberSettings(accountId, phoneNumber, settings) {
    try {
      const normalizedPhone = phoneNumber.replace(/\D/g, '');

      const { data, error } = await supabase
        .from('account_number_settings')
        .upsert({
          account_id: accountId,
          phone_number: normalizedPhone,
          webhook_enabled: settings.webhook_enabled !== false,
          chatbot_enabled: settings.chatbot_enabled !== false,
          flow_enabled: settings.flow_enabled !== false,
          notes: settings.notes || null,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'account_id,phone_number'
        })
        .select()
        .single();

      if (error) throw error;

      // Invalidate cache
      const cacheKey = `number_settings:${accountId}:${normalizedPhone}`;
      cacheManager.invalidate(cacheKey);

      return data;
    } catch (error) {
      logger.error('Error upserting number settings:', error);
      throw error;
    }
  },

  // Bulk upsert number settings (for n8n batch updates)
  async bulkUpsertNumberSettings(accountId, numbersArray) {
    try {
      const records = numbersArray.map(item => ({
        account_id: accountId,
        phone_number: (item.phone_number || item.phone || item.number || '').replace(/\D/g, ''),
        webhook_enabled: item.webhook_enabled !== false,
        chatbot_enabled: item.chatbot_enabled !== false,
        flow_enabled: item.flow_enabled !== false,
        notes: item.notes || null,
        updated_at: new Date().toISOString()
      }));

      const { data, error } = await supabase
        .from('account_number_settings')
        .upsert(records, {
          onConflict: 'account_id,phone_number'
        })
        .select();

      if (error) throw error;

      // Invalidate cache for all affected numbers
      records.forEach(r => {
        cacheManager.invalidate(`number_settings:${accountId}:${r.phone_number}`);
      });

      return data;
    } catch (error) {
      logger.error('Error bulk upserting number settings:', error);
      throw error;
    }
  },

  // Delete number settings
  async deleteNumberSettings(accountId, phoneNumber) {
    try {
      const normalizedPhone = phoneNumber.replace(/\D/g, '');

      const { error } = await supabase
        .from('account_number_settings')
        .delete()
        .eq('account_id', accountId)
        .eq('phone_number', normalizedPhone);

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`number_settings:${accountId}:${normalizedPhone}`);

      return true;
    } catch (error) {
      logger.error('Error deleting number settings:', error);
      throw error;
    }
  },

  // Quick check helpers (use cached data)
  async isWebhookEnabledForNumber(accountId, phoneNumber) {
    const settings = await this.getNumberSettings(accountId, phoneNumber);
    return settings.webhook_enabled !== false;
  },

  async isChatbotEnabledForNumber(accountId, phoneNumber) {
    const settings = await this.getNumberSettings(accountId, phoneNumber);
    return settings.chatbot_enabled !== false;
  },

  async isFlowEnabledForNumber(accountId, phoneNumber) {
    const settings = await this.getNumberSettings(accountId, phoneNumber);
    return settings.flow_enabled !== false;
  },
};

module.exports = {
  supabase,
  db,
  MissingWebhookQueueTableError
};
