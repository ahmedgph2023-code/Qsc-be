-- Meta WhatsApp module (multi-number support)

CREATE TABLE IF NOT EXISTS whatsapp_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(128) NOT NULL DEFAULT 'WhatsApp',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  phone_number_id VARCHAR(64),
  waba_id VARCHAR(64),
  display_phone_number VARCHAR(32),
  verify_token_hash VARCHAR(128),
  encrypted_credentials TEXT,
  connection_status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
  last_validated_at TIMESTAMPTZ,
  last_error TEXT,
  webhook_path VARCHAR(256) NOT NULL DEFAULT '/api/whatsapp/webhook',
  updated_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_config_phone_number_id
  ON whatsapp_config (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  wa_id VARCHAR(32) NOT NULL,
  display_name VARCHAR(256),
  business_name VARCHAR(512),
  last_message_preview TEXT,
  last_message_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  unread_count INTEGER NOT NULL DEFAULT 0,
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_conversations_config_wa
  ON whatsapp_conversations (config_id, wa_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_config ON whatsapp_conversations (config_id);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  direction VARCHAR(16) NOT NULL,
  message_type VARCHAR(32) NOT NULL DEFAULT 'text',
  body TEXT,
  template_name VARCHAR(128),
  template_language VARCHAR(16),
  template_components JSONB,
  wamid VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  error_code VARCHAR(64),
  error_message TEXT,
  media_id VARCHAR(128),
  media_mime_type VARCHAR(128),
  media_file_name VARCHAR(256),
  media_url TEXT,
  raw_payload JSONB,
  pricing_category VARCHAR(32),
  pricing_type VARCHAR(32),
  pricing_model VARCHAR(64),
  billable BOOLEAN,
  sent_by UUID,
  provider_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation
  ON whatsapp_messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_messages_wamid
  ON whatsapp_messages (wamid)
  WHERE wamid IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  event VARCHAR(128) NOT NULL,
  actor_id UUID,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_activity_config
  ON whatsapp_activity (config_id, created_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  title VARCHAR(128) NOT NULL,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_quick_replies_config ON whatsapp_quick_replies (config_id);
