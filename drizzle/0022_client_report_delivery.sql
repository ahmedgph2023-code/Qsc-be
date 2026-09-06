ALTER TABLE "client_report_global_settings"
  ADD COLUMN IF NOT EXISTS "delivery_config" jsonb NOT NULL DEFAULT '{
    "email": {"enabled": false, "smtpHost": "", "smtpPort": 587, "smtpUser": "", "smtpFrom": "", "smtpSecure": false},
    "linkDevice": {"enabled": false, "status": "disconnected", "sessionLabel": null},
    "metaWhatsapp": {"enabled": false, "configId": null, "templateName": null}
  }'::jsonb;

ALTER TABLE "client_report_configs"
  ADD COLUMN IF NOT EXISTS "recipient_phone" varchar(32);
