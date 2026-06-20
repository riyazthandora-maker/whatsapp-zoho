import { config } from './load-env';
config();

import { supabase } from '../lib/supabase';

async function run() {
  console.log('Testing Supabase connection...\n');

  // 1. Check sales_reps table
  console.log('Checking sales_reps table...');
  const { data: reps, error: repsError } = await supabase
    .from('sales_reps')
    .select('id, name, whatsapp_number, is_active, role');

  if (repsError) {
    console.error('  ERROR:', repsError.message);
    console.error('  → Have you run supabase/schema.sql in your Supabase project?');
    process.exit(1);
  }

  if (!reps?.length) {
    console.warn('  WARNING: No sales reps found. Add at least one rep to sales_reps table.');
  } else {
    reps.forEach((r) => console.log(`  • ${r.name} (${r.whatsapp_number}) — ${r.role}`));
  }

  // 2. Check zoho_customers table
  console.log('\nChecking zoho_customers table...');
  const { count, error: custError } = await supabase
    .from('zoho_customers')
    .select('*', { count: 'exact', head: true });

  if (custError) {
    console.error('  ERROR:', custError.message);
    process.exit(1);
  }

  console.log(`  ${count ?? 0} customers cached`);
  if ((count ?? 0) === 0) {
    console.warn('  → Run the sync: GET /api/sync-customers (or npm run dev then hit that endpoint)');
  }

  // 3. Check audit_log table
  console.log('\nChecking audit_log table...');
  const { count: auditCount, error: auditError } = await supabase
    .from('audit_log')
    .select('*', { count: 'exact', head: true });

  if (auditError) {
    console.error('  ERROR:', auditError.message);
    process.exit(1);
  }

  console.log(`  ${auditCount ?? 0} audit entries`);
  console.log('\nSupabase test complete.');
}

run().catch((err) => {
  console.error('Supabase test failed:', err.message);
  process.exit(1);
});
