/**
 * HTTP API Rate Limiting - Layer 2 Protection
 * ============================================================================
 * 
 * ARCHITECTURE (3 layers, defense in depth):
 * 
 * Layer 1 - Edge (external, not in this file):
 *   - Cloudflare / Nginx / AWS WAF
 *   - IP-based hard limits
 *   - DDoS protection
 *   - MUST exist in production
 * 
 * Layer 2 - API Semantics (THIS FILE):
 *   - Per-route rate limits
 *   - Prevents request floods from reaching business logic
 *   - Rejects requests BEFORE they queue work
 *   - Protects against: abuse, retry storms, buggy clients
 * 
 * Layer 3 - WhatsApp Behavior (in whatsappManager.js):
 *   - Per-account message pacing
 *   - Jitter and hourly caps
 *   - Assumes Layers 1 & 2 already filtered abuse
 * 
 * ============================================================================
 * 
 * CRITICAL: If you disable these limiters, you MUST have edge protection.
 * Without rate limiting, a single client can:
 *   - Exhaust server resources
 *   - Queue thousands of messages that flush in bursts
 *   - Trigger WhatsApp bans from traffic patterns
 *   - Create account farming clusters
 * 
 * ============================================================================
 */

const rateLimit = require('express-rate-limit');
const logger = require('./logger');

// ============================================================================
// CONFIGURATION - Adjust based on your expected traffic
// ============================================================================

const config = {
  // Set to 'true' to disable all rate limiting (ONLY if edge protection exists)
  DISABLE_RATE_LIMITING: process.env.DISABLE_RATE_LIMITING === 'true',
  
  // Trust proxy headers (required behind Cloudflare/Nginx/Load Balancer)
  TRUST_PROXY: process.env.TRUST_PROXY === 'true',
  
  // General API limits
  API_WINDOW_MS: parseInt(process.env.API_RATE_WINDOW_MS) || 60000,        // 1 minute
  API_MAX_REQUESTS: parseInt(process.env.API_RATE_MAX) || 100,              // 100 req/min
  
  // Auth endpoint limits (stricter - prevent brute force)
  AUTH_WINDOW_MS: parseInt(process.env.AUTH_RATE_WINDOW_MS) || 900000,     // 15 minutes
  AUTH_MAX_REQUESTS: parseInt(process.env.AUTH_RATE_MAX) || 10,             // 10 req/15min
  
  // Message send limits (prevent queue flooding)
  MESSAGE_WINDOW_MS: parseInt(process.env.MESSAGE_RATE_WINDOW_MS) || 60000, // 1 minute
  MESSAGE_MAX_REQUESTS: parseInt(process.env.MESSAGE_RATE_MAX) || 30,       // 30 req/min
  
  // Webhook creation limits (prevent spam)
  WEBHOOK_WINDOW_MS: parseInt(process.env.WEBHOOK_RATE_WINDOW_MS) || 3600000, // 1 hour
  WEBHOOK_MAX_REQUESTS: parseInt(process.env.WEBHOOK_RATE_MAX) || 20,          // 20 req/hour
  
  // Account creation limits (prevent farming)
  ACCOUNT_WINDOW_MS: parseInt(process.env.ACCOUNT_RATE_WINDOW_MS) || 86400000, // 24 hours
  ACCOUNT_MAX_REQUESTS: parseInt(process.env.ACCOUNT_RATE_MAX) || 5             // 5 accounts/day
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Key generator - uses IP + user combo for authenticated routes
 */
const keyGenerator = (req) => {
  // For authenticated requests, combine IP with user ID
  // This prevents one user from hogging limits for an entire IP
  const userId = req.session?.user?.id || req.user?.id || 'anonymous';
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  return `${ip}-${userId}`;
};

/**
 * Account-aware key generator for message endpoints
 * Rate limits per account, not just per user
 */
const accountKeyGenerator = (req) => {
  const accountId = req.body?.account_id || req.params?.id || 'unknown';
  const userId = req.session?.user?.id || req.user?.id || 'anonymous';
  return `${userId}-${accountId}`;
};

/**
 * Standard rate limit exceeded handler
 */
const limitHandler = (req, res, next, options) => {
  const retryAfter = Math.ceil(options.windowMs / 1000);
  logger.warn(`[RateLimit] ${options.message} - IP: ${req.ip}, Path: ${req.path}`);
  
  res.status(429).json({
    error: 'Too Many Requests',
    message: options.message,
    retryAfter: retryAfter,
    limit: options.limit,
    windowMs: options.windowMs
  });
};

/**
 * Skip function - allows bypassing limits for health checks, etc.
 */
const skipHealthChecks = (req) => {
  return req.path === '/health' || req.path === '/api/health';
};

// ============================================================================
// NO-OP LIMITER (for when rate limiting is disabled)
// ============================================================================

const noOpLimiter = (req, res, next) => next();

// ============================================================================
// RATE LIMITERS
// ============================================================================

/**
 * General API rate limiter
 * Applied to most endpoints
 */
const apiLimiter = config.DISABLE_RATE_LIMITING ? noOpLimiter : rateLimit({
  windowMs: config.API_WINDOW_MS,
  limit: config.API_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyGenerator,
  skip: skipHealthChecks,
  handler: (req, res, next, options) => limitHandler(req, res, next, {
    ...options,
    message: 'API rate limit exceeded. Please slow down.'
  })
});

/**
 * Auth endpoint rate limiter (stricter)
 * Prevents brute force attacks
 */
const authLimiter = config.DISABLE_RATE_LIMITING ? noOpLimiter : rateLimit({
  windowMs: config.AUTH_WINDOW_MS,
  limit: config.AUTH_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown', // IP only for auth
  handler: (req, res, next, options) => limitHandler(req, res, next, {
    ...options,
    message: 'Too many authentication attempts. Please try again later.'
  })
});

/**
 * Message sending rate limiter
 * Prevents queue flooding - critical for ban prevention
 * Rate limits per account, not just per user
 */
const messageLimiter = config.DISABLE_RATE_LIMITING ? noOpLimiter : rateLimit({
  windowMs: config.MESSAGE_WINDOW_MS,
  limit: config.MESSAGE_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: accountKeyGenerator,
  handler: (req, res, next, options) => {
    const accountId = req.body?.account_id || 'unknown';
    logger.warn(`[RateLimit] Message limit hit for account ${accountId}`);
    limitHandler(req, res, next, {
      ...options,
      message: 'Message rate limit exceeded. This protects your account from bans.'
    });
  }
});

/**
 * Webhook creation rate limiter
 * Prevents webhook spam and potential echo loops
 */
const webhookLimiter = config.DISABLE_RATE_LIMITING ? noOpLimiter : rateLimit({
  windowMs: config.WEBHOOK_WINDOW_MS,
  limit: config.WEBHOOK_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyGenerator,
  handler: (req, res, next, options) => limitHandler(req, res, next, {
    ...options,
    message: 'Webhook creation limit exceeded. Try again later.'
  })
});

/**
 * Account creation rate limiter (strictest)
 * Prevents account farming - critical for cluster ban prevention
 */
const accountLimiter = config.DISABLE_RATE_LIMITING ? noOpLimiter : rateLimit({
  windowMs: config.ACCOUNT_WINDOW_MS,
  limit: config.ACCOUNT_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown', // IP only - prevent farming
  handler: (req, res, next, options) => {
    logger.warn(`[RateLimit] Account creation limit hit - IP: ${req.ip}`);
    limitHandler(req, res, next, {
      ...options,
      message: 'Account creation limit exceeded. Maximum 5 accounts per day.'
    });
  }
});

// ============================================================================
// LOGGING
// ============================================================================

if (config.DISABLE_RATE_LIMITING) {
  logger.warn('⚠️  [RateLimit] ALL RATE LIMITING IS DISABLED');
  logger.warn('⚠️  [RateLimit] This is ONLY safe if edge protection (Cloudflare/Nginx) is configured');
  logger.warn('⚠️  [RateLimit] Set DISABLE_RATE_LIMITING=false to enable protection');
} else {
  logger.info('[RateLimit] HTTP rate limiting enabled:');
  logger.info(`  - API: ${config.API_MAX_REQUESTS} req/${config.API_WINDOW_MS/1000}s`);
  logger.info(`  - Auth: ${config.AUTH_MAX_REQUESTS} req/${config.AUTH_WINDOW_MS/1000}s`);
  logger.info(`  - Messages: ${config.MESSAGE_MAX_REQUESTS} req/${config.MESSAGE_WINDOW_MS/1000}s per account`);
  logger.info(`  - Webhooks: ${config.WEBHOOK_MAX_REQUESTS} req/${config.WEBHOOK_WINDOW_MS/1000}s`);
  logger.info(`  - Accounts: ${config.ACCOUNT_MAX_REQUESTS} req/${config.ACCOUNT_WINDOW_MS/1000}s per IP`);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  apiLimiter,
  authLimiter,
  messageLimiter,
  webhookLimiter,
  accountLimiter,
  config // Export config for testing/debugging
};
