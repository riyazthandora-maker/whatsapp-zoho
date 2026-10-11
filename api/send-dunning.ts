import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase';
import { getOverdueInvoices, getUpcomingDueInvoices } from '../lib/zoho';
import { sendTemplate } from '../lib/whatsapp';
import {
  createCommitment,
  updateCommitment,
  getCommitmentsForFollowup,
  createRepTask,
} from '../lib/dunning';
import type { CommitmentRecord } from '../types';

const COMPANY = () => process.env.COMPANY_NAME || 'Our Company';

// Testing filter — clear this array to run for all customers
const TEST_CUSTOMERS = [
  'FAVOURITE BUILDING MATERIAL LLC',
  'HABSHAN ELECT.&SANITARY WARE TR.',
];

const fmtAmount = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

async function getDefaultRepId(): Promise<string | null> {
  const phone = process.env.DUNNING_REP_PHONE;
  const q = supabase.from('sales_reps').select('id').eq('is_active', true);
  if (phone) q.eq('whatsapp_number', phone);
  else q.eq('role', 'admin');
  const { data } = await q.limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// Fetch all commitments for a list of invoice numbers in one query
async function getCommitmentsByInvoices(invoiceNumbers: string[]): Promise<Map<string, CommitmentRecord>> {
  if (!invoiceNumbers.length) return new Map();
  const { data } = await supabase
    .from('dunning_commitments')
    .select('*')
    .in('invoice_number', invoiceNumbers);
  const map = new Map<string, CommitmentRecord>();
  for (const row of (data ?? []) as CommitmentRecord[]) {
    map.set(row.invoice_number, row);
  }
  return map;
}

// Fetch all phones for a list of Zoho contact IDs in one query
async function getPhonesByContactIds(contactIds: string[]): Promise<Map<string, string>> {
  if (!contactIds.length) return new Map();
  const { data } = await supabase
    .from('zoho_customers')
    .select('zoho_contact_id, phone')
    .in('zoho_contact_id', contactIds);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as { zoho_contact_id: string; phone: string }[]) {
    if (row.phone?.trim()) map.set(row.zoho_contact_id, row.phone.trim());
  }
  return map;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = false;
  const customerFilter = TEST_CUSTOMERS.length > 0
    ? TEST_CUSTOMERS.map(s => s.toUpperCase())
    : null;
  const t0 = Date.now();
  const repId = await getDefaultRepId();
  let sent = 0;
  let advanced = 0;
  let finalized = 0;
  const errors: string[] = [];
  const preview: string[] = [];

  // ── Step 1: Advance notice (due in 7 days) ────────────────────────────────
  try {
    console.log('[send-dunning] fetching upcoming invoices...');
    const upcoming = await getUpcomingDueInvoices(7);
    const filteredUpcoming = customerFilter
      ? upcoming.filter(i => customerFilter.includes(i.customer_name.toUpperCase()))
      : upcoming;
    console.log(`[send-dunning] upcoming=${upcoming.length} filtered=${filteredUpcoming.length}`);

    const commitments = await getCommitmentsByInvoices(filteredUpcoming.map(i => i.invoice_number));
    const phones = await getPhonesByContactIds(filteredUpcoming.map(i => i.contact_id));

    for (const inv of filteredUpcoming) {
      try {
        if (commitments.has(inv.invoice_number)) continue;
        const phone = phones.get(inv.contact_id);
        if (!phone) continue;

        if (!dryRun) {
          await createCommitment({
            customer_zoho_id: inv.contact_id,
            customer_name: inv.customer_name,
            customer_phone: phone,
            invoice_number: inv.invoice_number,
            amount: inv.balance,
            assigned_rep_id: repId,
            template_step: 1,
          });
          await sendTemplate(phone, 'payment_advance_notice', 'en', [
            inv.customer_name,
            inv.invoice_number,
            fmtAmount(inv.balance),
            fmtDate(inv.due_date),
            COMPANY(),
          ]);
        }
        preview.push(`[advance] ${inv.customer_name} ${inv.invoice_number} AED ${fmtAmount(inv.balance)} → ${phone}`);
        sent++;
      } catch (err: any) {
        errors.push(`advance/${inv.invoice_number}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`advance-fetch: ${err?.message}`);
  }

  // ── Step 2: Start overdue dunning ─────────────────────────────────────────
  try {
    console.log('[send-dunning] fetching overdue invoices...');
    const overdue = await getOverdueInvoices();
    const filteredOverdue = customerFilter
      ? overdue.filter(i => customerFilter.includes(i.customer_name.toUpperCase()))
      : overdue;
    console.log(`[send-dunning] overdue=${overdue.length} filtered=${filteredOverdue.length}`);

    const commitments = await getCommitmentsByInvoices(filteredOverdue.map(i => i.invoice_number));
    const phones = await getPhonesByContactIds(filteredOverdue.map(i => i.contact_id));

    for (const inv of filteredOverdue) {
      try {
        const existing = commitments.get(inv.invoice_number);
        if (existing && existing.template_step >= 2) continue;

        const phone = phones.get(inv.contact_id);
        if (!phone) continue;

        if (!dryRun) {
          if (existing) {
            await updateCommitment(existing.id, {
              template_step: 2,
              template_sent_at: new Date().toISOString(),
            });
          } else {
            await createCommitment({
              customer_zoho_id: inv.contact_id,
              customer_name: inv.customer_name,
              customer_phone: phone,
              invoice_number: inv.invoice_number,
              amount: inv.balance,
              assigned_rep_id: repId,
              template_step: 2,
            });
          }
          await sendTemplate(phone, 'payment_overdue_collect', 'en', [
            inv.customer_name,
            inv.invoice_number,
            fmtAmount(inv.balance),
            fmtDate(inv.due_date),
            COMPANY(),
          ]);
        }
        preview.push(`[overdue] ${inv.customer_name} ${inv.invoice_number} AED ${fmtAmount(inv.balance)} → ${phone}`);
        sent++;
      } catch (err: any) {
        errors.push(`overdue/${inv.invoice_number}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`overdue-fetch: ${err?.message}`);
  }

  // ── Step 3: Follow-up (step 2, no reply in 24h) ───────────────────────────
  try {
    const toFollow = await getCommitmentsForFollowup(2, 24);
    for (const c of toFollow) {
      try {
        if (!dryRun) {
          await updateCommitment(c.id, {
            template_step: 3,
            template_sent_at: new Date().toISOString(),
          });
          await sendTemplate(c.customer_phone, 'payment_followup', 'en', [
            c.customer_name,
            c.invoice_number,
            fmtAmount(c.amount),
            COMPANY(),
          ]);
        }
        preview.push(`[followup] ${c.customer_name} ${c.invoice_number} AED ${fmtAmount(c.amount)} → ${c.customer_phone}`);
        advanced++;
      } catch (err: any) {
        errors.push(`followup/${c.invoice_number}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`followup-fetch: ${err?.message}`);
  }

  // ── Step 4: Final notice (step 3, no reply in 3 days) + create rep task ───
  try {
    const toFinalize = await getCommitmentsForFollowup(3, 72);
    for (const c of toFinalize) {
      try {
        const daysOverdue = Math.floor(
          (Date.now() - new Date(c.template_sent_at ?? c.created_at).getTime()) / 86_400_000
        );
        const taskDueDate = new Date();
        taskDueDate.setDate(taskDueDate.getDate() + 1);

        if (!dryRun) {
          await updateCommitment(c.id, {
            template_step: 4,
            template_sent_at: new Date().toISOString(),
            status: 'escalated',
          });
          await createRepTask({
            rep_id: c.assigned_rep_id,
            customer_zoho_id: c.customer_zoho_id,
            customer_name: c.customer_name,
            invoice_number: c.invoice_number,
            amount: c.amount,
            task_type: 'escalation',
            due_date: taskDueDate.toISOString().split('T')[0],
            note: `No response after 3 WhatsApp messages (${daysOverdue}d overdue)`,
          });
          await sendTemplate(c.customer_phone, 'payment_final_notice', 'en', [
            c.customer_name,
            c.invoice_number,
            fmtAmount(c.amount),
            String(daysOverdue),
            COMPANY(),
          ]);
        }
        preview.push(`[final] ${c.customer_name} ${c.invoice_number} AED ${fmtAmount(c.amount)} (${daysOverdue}d overdue) → ${c.customer_phone}`);
        finalized++;
      } catch (err: any) {
        errors.push(`final/${c.invoice_number}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`final-fetch: ${err?.message}`);
  }

  const elapsed = Date.now() - t0;
  console.log(`[send-dunning] done in ${elapsed}ms dry_run=${dryRun} sent=${sent} advanced=${advanced} finalized=${finalized} errors=${errors.length}`);
  if (errors.length) console.error('[send-dunning] errors:', errors);

  res.json({ dry_run: dryRun, sent, advanced, finalized, elapsed_ms: elapsed, errors, ...(dryRun && { preview }) });
}
