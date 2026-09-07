-- Meeting 3: schedule Daily / Weekly / Monthly / Custom days
ALTER TYPE client_report_frequency ADD VALUE IF NOT EXISTS 'weekly';
ALTER TYPE client_report_frequency ADD VALUE IF NOT EXISTS 'monthly';
