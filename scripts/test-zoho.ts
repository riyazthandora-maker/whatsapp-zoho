import { config } from './load-env';
config();

import { listContacts, getStatementSummary } from '../lib/zoho';

async function run() {
  console.log('Testing Zoho Books connection...\n');

  // 1. List first page of customers
  console.log('Fetching customer list (first 5)...');
  const contacts = await listContacts(1);

  if (!contacts.length) {
    console.error('No contacts returned. Check ZOHO_ORGANIZATION_ID and OAuth credentials.');
    process.exit(1);
  }

  const sample = contacts.slice(0, 5);
  sample.forEach((c, i) =>
    console.log(`  ${i + 1}. [${c.contact_id}] ${c.contact_name}`)
  );
  console.log(`  ... (${contacts.length} total on page 1)\n`);

  // 2. Fetch statement summary for first customer
  const first = contacts[0];
  const today = new Date();
  const fromDate = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    .toISOString()
    .split('T')[0];
  const toDate = new Date(today.getFullYear(), today.getMonth(), 0)
    .toISOString()
    .split('T')[0];

  console.log(`Fetching statement for "${first.contact_name}" (${fromDate} → ${toDate})...`);
  const summary = await getStatementSummary(first.contact_id, fromDate, toDate);
  console.log('  Summary:', JSON.stringify(summary, null, 2));

  console.log('\nZoho test complete.');
}

run().catch((err) => {
  console.error('Zoho test failed:', err.message);
  process.exit(1);
});
