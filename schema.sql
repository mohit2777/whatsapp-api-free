-- =============================================================================
-- WhatsApp Multi-Automation - Complete Supabase Schema
-- Final Production Schema - Run this in Supabase SQL Editor
-- =============================================================================
--
-- VERSION: 1.0.0
-- LAST UPDATED: 2026-01-18
--
-- This is the complete schema for a fresh installation.
-- No migrations needed - this creates everything from scratch.
--
-- =============================================================================

-- ============================================================================
-- EXPRESS SESSION TABLE (for connect-pg-simple)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR NOT NULL COLLATE "default",
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Accounts table (WhatsApp connections)
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    phone_number VARCHAR(50),
    status VARCHAR(50) DEFAULT 'disconnected',
    session_data TEXT,  -- Baileys auth blob (base64 encoded JSON with creds + keys)
    last_session_saved TIMESTAMPTZ,
    qr_code TEXT,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions table (alternative session storage - optional backup)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    session_data TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id)
);

-- ============================================================================
-- WEBHOOKS
-- ============================================================================

-- Webhooks table
-- Supported events: 'message', 'message_ack', '*' (all events)
-- message_ack statuses: sent (2), delivered (3), read (4)
CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT[] DEFAULT ARRAY['message'],
    secret TEXT,
    headers JSONB DEFAULT '{}',
    max_retries INTEGER DEFAULT 5,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook delivery queue (for pending/retry deliveries)
CREATE TABLE IF NOT EXISTS webhook_delivery_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    webhook_url TEXT NOT NULL,
    webhook_secret TEXT,
    payload JSONB NOT NULL,
    max_retries INTEGER DEFAULT 5,
    attempt_count INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',  -- pending, processing, success, failed, dead_letter
    response_status INTEGER,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook deliveries log (completed deliveries history)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    payload JSONB,
    response_status INTEGER,
    response_body TEXT,
    attempts INTEGER DEFAULT 1,
    status VARCHAR(50) DEFAULT 'success',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);

-- ============================================================================
-- AI CHATBOT
-- ============================================================================

-- AI Auto Reply configurations (per account)
CREATE TABLE IF NOT EXISTS ai_auto_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT false,
    provider VARCHAR(50) DEFAULT 'gemini',  -- gemini, groq, openai, anthropic, openrouter
    model VARCHAR(100),
    api_key TEXT,  -- Encrypted in production
    system_prompt TEXT DEFAULT 'You are a helpful assistant.',
    knowledge_base TEXT,  -- Custom knowledge for AI context
    temperature DECIMAL(3,2) DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 500,
    history_limit INTEGER DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id)
);

-- Chatbot conversation history (for AI memory)
CREATE TABLE IF NOT EXISTS chatbot_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    contact_number VARCHAR(50) NOT NULL,
    context JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'active',  -- active, completed, expired
    started_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PER-NUMBER SETTINGS (Whitelist/Blacklist)
-- ============================================================================

CREATE TABLE IF NOT EXISTS account_number_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    phone_number VARCHAR(50) NOT NULL,
    webhook_enabled BOOLEAN DEFAULT true,
    chatbot_enabled BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id, phone_number)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Session indexes
CREATE INDEX IF NOT EXISTS idx_session_expire ON "session" ("expire");

-- Core indexes
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);

-- Webhook indexes
CREATE INDEX IF NOT EXISTS idx_webhooks_account_id ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhook_queue_status ON webhook_delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_next_attempt ON webhook_delivery_queue(next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);

-- AI/Chatbot indexes
CREATE INDEX IF NOT EXISTS idx_ai_auto_replies_account ON ai_auto_replies(account_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_account ON chatbot_conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_contact ON chatbot_conversations(account_id, contact_number);
CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_active ON chatbot_conversations(status) WHERE status = 'active';

-- Number settings indexes
CREATE INDEX IF NOT EXISTS idx_number_settings_account ON account_number_settings(account_id);
CREATE INDEX IF NOT EXISTS idx_number_settings_phone ON account_number_settings(account_id, phone_number);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers to all tables
DO $$
DECLARE
    tbl TEXT;
    tables TEXT[] := ARRAY['accounts', 'sessions', 'webhooks', 'webhook_delivery_queue', 
                           'ai_auto_replies', 'chatbot_conversations', 'account_number_settings'];
BEGIN
    FOREACH tbl IN ARRAY tables
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS update_%s_updated_at ON %I', tbl, tbl);
        EXECUTE format('CREATE TRIGGER update_%s_updated_at 
                        BEFORE UPDATE ON %I 
                        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', tbl, tbl);
    END LOOP;
END $$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on account_number_settings (required for Supabase)
ALTER TABLE account_number_settings ENABLE ROW LEVEL SECURITY;

-- Allow all operations policy (adjust for multi-tenant setups)
DROP POLICY IF EXISTS "Allow all operations on account_number_settings" ON account_number_settings;
CREATE POLICY "Allow all operations on account_number_settings"
ON account_number_settings FOR ALL USING (true);

-- ============================================================================
-- COMMENTS (Documentation)
-- ============================================================================

COMMENT ON TABLE accounts IS 'WhatsApp account connections with Baileys auth state';
COMMENT ON COLUMN accounts.session_data IS 'Base64 encoded Baileys auth blob: { creds, keys, version, activeInstanceId, savedAt }';
COMMENT ON COLUMN accounts.status IS 'Connection status: disconnected, initializing, qr_ready, ready, reconnecting, logged_out, error, owned_by_other';

COMMENT ON TABLE webhooks IS 'Webhook endpoints for message delivery notifications';
COMMENT ON COLUMN webhooks.events IS 'Event types to deliver: message, message_ack, or * for all';

COMMENT ON TABLE ai_auto_replies IS 'AI chatbot configuration per account';
COMMENT ON COLUMN ai_auto_replies.provider IS 'LLM provider: gemini, groq, openai, anthropic, openrouter';
COMMENT ON COLUMN ai_auto_replies.knowledge_base IS 'Custom knowledge content for AI context';

COMMENT ON TABLE account_number_settings IS 'Per-phone-number settings for whitelist/blacklist behavior';

-- ============================================================================
-- DONE
-- ============================================================================
-- Schema creation complete. No migrations needed for fresh installations.
-- =============================================================================
