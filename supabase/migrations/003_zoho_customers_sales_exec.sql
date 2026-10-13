-- Capture each customer's sales executive (Zoho custom field cf_sales_executive
-- / cf_sales_executive_contact) so dunning tasks route to the right rep.
ALTER TABLE zoho_customers ADD COLUMN IF NOT EXISTS sales_exec_name  TEXT;
ALTER TABLE zoho_customers ADD COLUMN IF NOT EXISTS sales_exec_phone TEXT;
