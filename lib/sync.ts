import { listContacts } from './zoho';
import { supabase } from './supabase';

export async function syncCustomers(): Promise<number> {
  let page = 1;
  let synced = 0;

  while (true) {
    const contacts = await listContacts(page);
    if (!contacts.length) break;

    const rows = contacts.map((c) => ({
      zoho_contact_id: c.contact_id,
      name: c.contact_name,
      email: c.email || null,
      phone: c.phone || null,
      updated_at: new Date().toISOString(),
    }));

    await supabase
      .from('zoho_customers')
      .upsert(rows, { onConflict: 'zoho_contact_id' });

    synced += rows.length;
    page++;

    if (rows.length < 200) break;
  }

  return synced;
}
