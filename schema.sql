-- ============================================================================
-- WHATSAPP MULTI-AUTOMATION V2 - UNIFIED DATABASE SCHEMA
-- ============================================================================
-- Run this file in your new Supabase project to set up the database
-- Last Updated: 2024-12-23
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- WhatsApp Accounts Table
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'initializing' CHECK (status IN ('initializing', 'qr_ready', 'ready', 'disconnected', 'auth_failed', 'error')),
    phone_number VARCHAR(50),
    api_key VARCHAR(64) UNIQUE, -- API key for sending messages without login
    session_data TEXT, -- Base64 encoded WhatsApp Web session data (~12MB)
    last_session_saved TIMESTAMP WITH TIME ZONE,
    qr_code TEXT,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_accounts_api_key ON whatsapp_accounts(api_key);

COMMENT ON TABLE whatsapp_accounts IS 'Stores WhatsApp account information and session data';
COMMENT ON COLUMN whatsapp_accounts.session_data IS 'Base64 encoded WhatsApp Web session data for persistent authentication';
COMMENT ON COLUMN whatsapp_accounts.api_key IS 'API key for authenticating message sending without login';

-- Webhooks Table
CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    secret VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    retry_count INTEGER DEFAULT 0,
    last_success_at TIMESTAMP WITH TIME ZONE,
    last_failure_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE webhooks IS 'Webhook configurations for message forwarding';

-- Message Logs Table
CREATE TABLE IF NOT EXISTS message_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    direction VARCHAR(50) NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'webhook', 'webhook_incoming')),
    message_id VARCHAR(255),
    sender VARCHAR(255),
    recipient VARCHAR(255),
    message TEXT,
    timestamp BIGINT,
    type VARCHAR(50),
    chat_id VARCHAR(255),
    is_group BOOLEAN DEFAULT false,
    group_name VARCHAR(255),
    media JSONB,
    status VARCHAR(50) DEFAULT 'success' CHECK (status IN ('success', 'failed', 'pending', 'delivered', 'read')),
    error_message TEXT,
    webhook_id UUID REFERENCES webhooks(id) ON DELETE SET NULL,
    webhook_url VARCHAR(500),
    response_status INTEGER,
    processing_time_ms INTEGER,
    retry_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE message_logs IS 'Message activity logs (can be disabled via DISABLE_MESSAGE_LOGGING env var)';

-- Webhook Delivery Queue
CREATE TABLE IF NOT EXISTS webhook_delivery_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    webhook_url VARCHAR(500) NOT NULL,
    webhook_secret VARCHAR(255),
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed', 'dead_letter')),
    attempt_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 5,
    last_error TEXT,
    response_status INTEGER,
    next_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE webhook_delivery_queue IS 'Durable webhook delivery queue with retries';

-- AI Auto Reply Configuration
CREATE TABLE IF NOT EXISTS ai_auto_replies (
    account_id UUID PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    api_key TEXT,
    model TEXT,
    system_prompt TEXT,
    history_limit INTEGER DEFAULT 10,
    temperature NUMERIC DEFAULT 0.7,
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE ai_auto_replies IS 'Per-account AI chatbot configuration';

-- ============================================================================
-- EXPRESS SESSION TABLE (For Render/Cloud deployments)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR NOT NULL COLLATE "default",
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

COMMENT ON TABLE session IS 'Express session storage for cloud deployments';

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- WhatsApp Accounts
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_status ON whatsapp_accounts(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_created_at ON whatsapp_accounts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone_number ON whatsapp_accounts(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_last_active ON whatsapp_accounts(last_active_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_session_data ON whatsapp_accounts(id) WHERE session_data IS NOT NULL;

-- Webhooks
CREATE INDEX IF NOT EXISTS idx_webhooks_account_id ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_is_active ON webhooks(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhooks_account_active ON webhooks(account_id, is_active) WHERE is_active = true;

-- Message Logs (optimized for common queries)
CREATE INDEX IF NOT EXISTS idx_message_logs_account_id ON message_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_direction ON message_logs(direction);
CREATE INDEX IF NOT EXISTS idx_message_logs_status ON message_logs(status);
CREATE INDEX IF NOT EXISTS idx_message_logs_created_at ON message_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_account_created ON message_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_webhook_id ON message_logs(webhook_id) WHERE webhook_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_logs_chat_id ON message_logs(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_logs_message_id ON message_logs(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_logs_account_direction ON message_logs(account_id, direction);
CREATE INDEX IF NOT EXISTS idx_message_logs_account_status ON message_logs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_message_logs_account_direction_status ON message_logs(account_id, direction, status);
CREATE INDEX IF NOT EXISTS idx_message_logs_daily_stats ON message_logs(created_at, direction) WHERE sender != 'status@broadcast';
CREATE INDEX IF NOT EXISTS idx_message_logs_conversation ON message_logs(account_id, sender, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_recipient ON message_logs(account_id, recipient, created_at DESC);

-- Webhook Delivery Queue
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_status ON webhook_delivery_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_account ON webhook_delivery_queue(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_webhook ON webhook_delivery_queue(webhook_id);

-- AI Auto Replies
CREATE INDEX IF NOT EXISTS idx_ai_auto_replies_account_id ON ai_auto_replies(account_id);
CREATE INDEX IF NOT EXISTS idx_ai_auto_replies_is_active ON ai_auto_replies(is_active) WHERE is_active = true;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_auto_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_queue ENABLE ROW LEVEL SECURITY;

-- Allow all operations (customize based on your auth needs)
CREATE POLICY "Allow all operations on whatsapp_accounts" ON whatsapp_accounts FOR ALL USING (true);
CREATE POLICY "Allow all operations on webhooks" ON webhooks FOR ALL USING (true);
CREATE POLICY "Allow all operations on message_logs" ON message_logs FOR ALL USING (true);
CREATE POLICY "Allow all operations on ai_auto_replies" ON ai_auto_replies FOR ALL USING (true);
CREATE POLICY "Allow all operations on webhook_delivery_queue" ON webhook_delivery_queue FOR ALL USING (true);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Get message stats for an account
CREATE OR REPLACE FUNCTION get_message_stats(account_uuid UUID)
RETURNS TABLE(
    total BIGINT,
    incoming BIGINT,
    outgoing BIGINT,
    success BIGINT,
    failed BIGINT,
    pending BIGINT,
    last_24h BIGINT,
    avg_processing_time_ms NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE direction = 'incoming') as incoming,
        COUNT(*) FILTER (WHERE direction = 'outgoing') as outgoing,
        COUNT(*) FILTER (WHERE status = 'success') as success,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h,
        AVG(processing_time_ms) FILTER (WHERE processing_time_ms IS NOT NULL) as avg_processing_time_ms
    FROM message_logs
    WHERE account_id = account_uuid;
END;
$$ LANGUAGE plpgsql;

-- Get all accounts stats (avoids N+1)
CREATE OR REPLACE FUNCTION get_all_accounts_stats()
RETURNS TABLE(
    account_id UUID,
    total BIGINT,
    incoming BIGINT,
    outgoing BIGINT,
    success BIGINT,
    failed BIGINT,
    outgoing_success BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ml.account_id,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE ml.direction = 'incoming') as incoming,
        COUNT(*) FILTER (WHERE ml.direction = 'outgoing') as outgoing,
        COUNT(*) FILTER (WHERE ml.status = 'success') as success,
        COUNT(*) FILTER (WHERE ml.status = 'failed') as failed,
        COUNT(*) FILTER (WHERE ml.direction = 'outgoing' AND ml.status = 'success') as outgoing_success
    FROM message_logs ml
    WHERE ml.sender != 'status@broadcast'
    GROUP BY ml.account_id;
END;
$$ LANGUAGE plpgsql;

-- Get daily message stats
CREATE OR REPLACE FUNCTION get_daily_message_stats(days_count INTEGER DEFAULT 7)
RETURNS TABLE(
    date DATE,
    incoming BIGINT,
    outgoing BIGINT,
    total BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        DATE(ml.created_at) as date,
        COUNT(*) FILTER (WHERE ml.direction = 'incoming') as incoming,
        COUNT(*) FILTER (WHERE ml.direction = 'outgoing') as outgoing,
        COUNT(*) as total
    FROM message_logs ml
    WHERE ml.created_at >= NOW() - (days_count || ' days')::INTERVAL
      AND ml.sender != 'status@broadcast'
    GROUP BY DATE(ml.created_at)
    ORDER BY date ASC;
END;
$$ LANGUAGE plpgsql;

-- Cleanup old messages (data retention)
CREATE OR REPLACE FUNCTION cleanup_old_messages(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM message_logs
    WHERE created_at < NOW() - (days_to_keep || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Session data functions
CREATE OR REPLACE FUNCTION save_session_data(p_account_id UUID, p_session_data TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE whatsapp_accounts
    SET session_data = p_session_data, last_session_saved = NOW(), updated_at = NOW()
    WHERE id = p_account_id;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_session_data(p_account_id UUID)
RETURNS TEXT AS $$
DECLARE v_session_data TEXT;
BEGIN
    SELECT session_data INTO v_session_data FROM whatsapp_accounts WHERE id = p_account_id;
    RETURN v_session_data;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION clear_session_data(p_account_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE whatsapp_accounts
    SET session_data = NULL, last_session_saved = NULL, status = 'disconnected', updated_at = NOW()
    WHERE id = p_account_id;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE TRIGGER update_whatsapp_accounts_updated_at 
    BEFORE UPDATE ON whatsapp_accounts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_webhooks_updated_at 
    BEFORE UPDATE ON webhooks 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_webhook_queue_updated_at
    BEFORE UPDATE ON webhook_delivery_queue
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ai_auto_replies_updated_at 
    BEFORE UPDATE ON ai_auto_replies 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Active accounts summary
CREATE OR REPLACE VIEW active_accounts_summary AS
SELECT 
    wa.id,
    wa.name,
    wa.status,
    wa.phone_number,
    wa.last_active_at,
    COUNT(DISTINCT w.id) as webhook_count,
    COUNT(DISTINCT w.id) FILTER (WHERE w.is_active = true) as active_webhook_count,
    COUNT(ml.id) FILTER (WHERE ml.created_at > NOW() - INTERVAL '24 hours') as messages_last_24h
FROM whatsapp_accounts wa
LEFT JOIN webhooks w ON wa.id = w.account_id
LEFT JOIN message_logs ml ON wa.id = ml.account_id
GROUP BY wa.id, wa.name, wa.status, wa.phone_number, wa.last_active_at;

-- Webhook delivery stats
CREATE OR REPLACE VIEW webhook_delivery_stats AS
SELECT 
    w.id,
    w.account_id,
    w.url,
    w.is_active,
    COUNT(ml.id) as total_deliveries,
    COUNT(ml.id) FILTER (WHERE ml.status = 'success') as successful_deliveries,
    COUNT(ml.id) FILTER (WHERE ml.status = 'failed') as failed_deliveries,
    MAX(ml.created_at) FILTER (WHERE ml.status = 'success') as last_success_at,
    MAX(ml.created_at) FILTER (WHERE ml.status = 'failed') as last_failure_at
FROM webhooks w
LEFT JOIN message_logs ml ON w.id = ml.webhook_id
GROUP BY w.id, w.account_id, w.url, w.is_active;

-- ============================================================================
-- REFRESH SCHEMA CACHE (Supabase specific)
-- ============================================================================

NOTIFY pgrst, 'reload schema';
