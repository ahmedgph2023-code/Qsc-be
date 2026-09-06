import {
  pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb, index, pgEnum,
} from "drizzle-orm/pg-core";

export const clientReportFrequencyEnum = pgEnum("client_report_frequency", ["daily", "custom"]);
export const clientReportSendStatusEnum = pgEnum("client_report_send_status", [
  "pending", "sent", "failed", "skipped",
]);
export const clientReportTriggerEnum = pgEnum("client_report_trigger", ["scheduled", "manual"]);

/** Report sections selectable per client — independent of statement kind enums elsewhere. */
export type ClientReportSection =
  | "portfolio_statement"
  | "account_statement"
  | "realized_summary"
  | "realized_details"
  | "balance_snapshot"
  | "transactions"
  | "performance";

export type ClientReportGlobalSettings = {
  schedulingEnabled: boolean;
  dataSections: ClientReportSection[];
  frequencyType: "daily" | "custom";
  customDays: number[];
  sendTime: string;
  asOfMode: "latest" | "previous_trading_day";
  rangeDays: number;
};

export type ClientReportEmailDelivery = {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpFrom: string;
  smtpSecure: boolean;
  /** Stored in delivery_config JSON; prefer UI over env when set. */
  smtpPassword: string;
};

export type ClientReportLinkDeviceDelivery = {
  enabled: boolean;
  status: "disconnected" | "pending" | "connected";
  sessionLabel: string | null;
};

export type ClientReportMetaWhatsappDelivery = {
  enabled: boolean;
  configId: string | null;
  templateName: string | null;
};

/** Client-supplied Wassenger API for outbound report WhatsApp (text / optional media URL). */
export type ClientReportWassengerDelivery = {
  enabled: boolean;
  apiUrl: string;
  apiToken: string;
};

export type ClientReportDeliveryConfig = {
  email: ClientReportEmailDelivery;
  linkDevice: ClientReportLinkDeviceDelivery;
  metaWhatsapp: ClientReportMetaWhatsappDelivery;
  wassenger: ClientReportWassengerDelivery;
};

export const DEFAULT_CLIENT_REPORT_DELIVERY: ClientReportDeliveryConfig = {
  email: {
    enabled: false,
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpFrom: "",
    smtpSecure: false,
    smtpPassword: "",
  },
  linkDevice: { enabled: false, status: "disconnected", sessionLabel: "QSC Reports Desk" },
  metaWhatsapp: { enabled: false, configId: null, templateName: null },
  wassenger: {
    enabled: false,
    apiUrl: "https://api.wassenger.com/v1/messages",
    apiToken: "",
  },
};

/** Singleton row (id=1) — default schedule + report sections for all clients. */
export const clientReportGlobalSettings = pgTable("client_report_global_settings", {
  id: integer("id").primaryKey().default(1),
  schedulingEnabled: boolean("scheduling_enabled").notNull().default(true),
  dataSections: jsonb("data_sections").$type<ClientReportSection[]>().notNull().default([]),
  frequencyType: clientReportFrequencyEnum("frequency_type").notNull().default("daily"),
  customDays: jsonb("custom_days").$type<number[]>().notNull().default([]),
  sendTime: varchar("send_time", { length: 5 }).notNull().default("09:00"),
  asOfMode: varchar("as_of_mode", { length: 32 }).notNull().default("latest"),
  rangeDays: integer("range_days").notNull().default(1),
  deliveryConfig: jsonb("delivery_config").$type<ClientReportDeliveryConfig>().notNull().default(DEFAULT_CLIENT_REPORT_DELIVERY),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const clientReportConfigs = pgTable("client_report_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  extClientId: integer("ext_client_id").notNull().unique(),
  clientName: varchar("client_name", { length: 300 }),
  /** When true, client receives scheduled reports (if global scheduling is on). */
  enabled: boolean("enabled").notNull().default(false),
  recipientEmail: varchar("recipient_email", { length: 320 }),
  recipientPhone: varchar("recipient_phone", { length: 32 }),
  /** Empty = inherit global dataSections. */
  dataSections: jsonb("data_sections").$type<ClientReportSection[]>().notNull().default([]),
  frequencyType: clientReportFrequencyEnum("frequency_type").notNull().default("daily"),
  customDays: jsonb("custom_days").$type<number[]>().notNull().default([]),
  sendTime: varchar("send_time", { length: 5 }).notNull().default("09:00"),
  asOfMode: varchar("as_of_mode", { length: 32 }).notNull().default("latest"),
  rangeDays: integer("range_days").notNull().default(1),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_client_report_configs_enabled").on(t.enabled),
  index("idx_client_report_configs_next").on(t.nextScheduledAt),
]);

export const clientReportSendLog = pgTable("client_report_send_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  configId: uuid("config_id").notNull().references(() => clientReportConfigs.id, { onDelete: "cascade" }),
  extClientId: integer("ext_client_id").notNull(),
  triggerType: clientReportTriggerEnum("trigger_type").notNull(),
  status: clientReportSendStatusEnum("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  payload: jsonb("payload"),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow(),
  sentBy: uuid("sent_by"),
}, (t) => [
  index("idx_client_report_send_log_config").on(t.configId),
  index("idx_client_report_send_log_client").on(t.extClientId),
]);
