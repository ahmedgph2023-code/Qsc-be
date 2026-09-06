import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const whatsappConnectionStatus = [
  "disconnected",
  "connected",
  "error",
  "disabled",
] as const;

export const whatsappMessageDirection = ["inbound", "outbound"] as const;

export const whatsappMessageStatus = [
  "pending",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "received",
] as const;

export const whatsappConfig = pgTable(
  "whatsapp_config",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    label: varchar("label", { length: 128 }).notNull().default("WhatsApp"),
    enabled: boolean("enabled").notNull().default(false),
    phoneNumberId: varchar("phone_number_id", { length: 64 }),
    wabaId: varchar("waba_id", { length: 64 }),
    displayPhoneNumber: varchar("display_phone_number", { length: 32 }),
    verifyTokenHash: varchar("verify_token_hash", { length: 128 }),
    encryptedCredentials: text("encrypted_credentials"),
    connectionStatus: varchar("connection_status", { length: 32 })
      .notNull()
      .default("disconnected"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastError: text("last_error"),
    webhookPath: varchar("webhook_path", { length: 256 })
      .notNull()
      .default("/api/whatsapp/webhook"),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_whatsapp_config_phone_number_id").on(table.phoneNumberId),
  ],
);

export const whatsappConversations = pgTable(
  "whatsapp_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    configId: uuid("config_id")
      .notNull()
      .references(() => whatsappConfig.id, { onDelete: "cascade" }),
    waId: varchar("wa_id", { length: 32 }).notNull(),
    displayName: varchar("display_name", { length: 256 }),
    businessName: varchar("business_name", { length: 512 }),
    lastMessagePreview: text("last_message_preview"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    unreadCount: integer("unread_count").notNull().default(0),
    isFavorite: boolean("is_favorite").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_whatsapp_conversations_config_wa").on(table.configId, table.waId),
    index("idx_whatsapp_conversations_config").on(table.configId),
  ],
);

export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => whatsappConversations.id, { onDelete: "cascade" }),
    direction: varchar("direction", { length: 16 }).notNull(),
    messageType: varchar("message_type", { length: 32 }).notNull().default("text"),
    body: text("body"),
    templateName: varchar("template_name", { length: 128 }),
    templateLanguage: varchar("template_language", { length: 16 }),
    templateComponents: jsonb("template_components"),
    wamid: varchar("wamid", { length: 128 }),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    mediaId: varchar("media_id", { length: 128 }),
    mediaMimeType: varchar("media_mime_type", { length: 128 }),
    mediaFileName: varchar("media_file_name", { length: 256 }),
    mediaUrl: text("media_url"),
    rawPayload: jsonb("raw_payload"),
    pricingCategory: varchar("pricing_category", { length: 32 }),
    pricingType: varchar("pricing_type", { length: 32 }),
    pricingModel: varchar("pricing_model", { length: 64 }),
    billable: boolean("billable"),
    sentBy: uuid("sent_by"),
    providerTimestamp: timestamp("provider_timestamp", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_whatsapp_messages_conversation").on(table.conversationId, table.createdAt),
    uniqueIndex("uq_whatsapp_messages_wamid").on(table.wamid),
  ],
);

export const whatsappActivity = pgTable(
  "whatsapp_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    configId: uuid("config_id").references(() => whatsappConfig.id, { onDelete: "set null" }),
    event: varchar("event", { length: 128 }).notNull(),
    actorId: uuid("actor_id"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_whatsapp_activity_config").on(table.configId, table.createdAt)],
);

export const whatsappQuickReplies = pgTable(
  "whatsapp_quick_replies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    configId: uuid("config_id")
      .notNull()
      .references(() => whatsappConfig.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 128 }).notNull(),
    body: text("body").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_whatsapp_quick_replies_config").on(table.configId)],
);
