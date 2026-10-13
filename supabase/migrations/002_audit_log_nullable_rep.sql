-- Allow customer-initiated statement requests to be logged without a rep.
-- The dunning bot now serves statements directly to customers, which have no
-- rep identity to attribute the delivery to.
ALTER TABLE audit_log ALTER COLUMN rep_name  DROP NOT NULL;
ALTER TABLE audit_log ALTER COLUMN rep_phone DROP NOT NULL;
