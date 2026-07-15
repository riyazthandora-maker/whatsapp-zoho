-- Enable Row-Level Security on all tables.
-- The backend uses the service_role key which bypasses RLS, so no
-- explicit policies are required. This simply locks out the anon/public role.
ALTER TABLE sales_reps     ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;
