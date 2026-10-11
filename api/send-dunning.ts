import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase';
import { getOverdueInvoices, getUpcomingDueInvoices } from '../lib/zoho';
import type { OverdueInvoice } from '../lib/zoho';
import { sendTemplate } from '../lib/whatsapp';
import {
  createCommitment,
  updateCommitment,
  getCommitmentsForFollowup,
  createRepTask,
  normalizePhone,
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

function invoiceList(invoices: { invoice_number: string }[]): string {
  if (invoices.length <= 3) return invoices.map(i => i.invoice_number).join(', ');
  return invoices.slice(0, 3).map(i => i.invoice_number).join(', ') + '...';
}

function groupByCustomer<T extends { customer_name: string }>(invoices: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const inv of invoices) {
    const key = inv.customer_name.trim().toUpperCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(inv);
  }
  return map;
}

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
    .from('collection_commitments')
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
    const norm = normalizePhone(row.phone ?? '');
    if (norm) map.set(row.zoho_contact_id, norm);
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

  // Pre-fetch overdue customers so advance step can skip them
  let overdueCustomerNames = new Set<string>();
  try {
    const overdueAll = await getOverdueInvoices();
    const filteredOD = customerFilter
      ? overdueAll.filter(i => customerFilter.includes(i.customer_name.toUpperCase()))
      : overdueAll;
    filteredOD.forEach(i => overdueCustomerNames.add(i.customer_name.trim().toUpperCase()));
  } catch { /* non-fatal — advance step will just send to everyone */ }

  // ── Step 1: Advance notice (due in 7 days) — skip customers who have overdue ─
  try {
    console.log('[send-dunning] fetching upcoming invoices...');
    const upcoming = await getUpcomingDueInvoices(7);
    const filteredUpcoming = customerFilter
      ? upcoming.filter(i => customerFilter.includes(i.customer_name.toUpperCase()))
            .filter(i => !overdueCustomerNames.has(i.customer_name.trim().toUpperCase()))
      : upcoming.filter(i => !overdueCustomerNames.has(i.customer_name.trim().toUpperCase()));
    console.log(`[send-dunning] upcoming=${upcoming.length} filtered=${filteredUpcoming.length}`);

    const upcomingCommitments = await getCommitmentsByInvoices(filteredUpcoming.map(i => i.invoice_number));
    const upcomingPhones = await getPhonesByContactIds(filteredUpcoming.map(i => i.contact_id));

    for (const [, group] of groupByCustomer(filteredUpcoming)) {
      try {
        const newInvoices = group.filter(i => !upcomingCommitments.has(i.invoice_number));
        if (!newInvoices.length) continue;
        const phone = upcomingPhones.get(newInvoices[0].contact_id);
        if (!phone) continue;

        const total = newInvoices.reduce((s, i) => s + i.balance, 0);
        const invStr = invoiceList(newInvoices);
        const earliestDue = newInvoices.reduce((a, b) => a.due_date < b.due_date ? a : b).due_date;

        if (!dryRun) {
          for (const inv of newInvoices) {
            await createCommitment({
              customer_zoho_id: inv.contact_id,
              customer_name: inv.customer_name,
              customer_phone: phone,
              invoice_number: inv.invoice_number,
              amount: inv.balance,
              assigned_rep_id: repId,
              template_step: 1,
            });
          }
          await sendTemplate(phone, 'payment_advance_notice', 'en', [
            newInvoices[0].customer_name,
            invStr,
            fmtAmount(total),
            fmtDate(earliestDue),
            COMPANY(),
          ]);
        }
        preview.push(`[advance] ${newInvoices[0].customer_name} | ${invStr} | AED ${fmtAmount(total)} → ${phone}`);
        sent++;
      } catch (err: any) {
        errors.push(`advance/${group[0].contact_id}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`advance-fetch: ${err?.message}`);
  }

  // ── Step 2: Overdue notice — one message per customer, sent last ──────────
  try {
    console.log('[send-dunning] fetching overdue invoices...');
    const overdue = await getOverdueInvoices();
    const filteredOverdue = customerFilter
      ? overdue.filter(i => customerFilter.includes(i.customer_name.toUpperCase()))
      : overdue;
    overdueCustomerNames = new Set(filteredOverdue.map(i => i.customer_name.trim().toUpperCase()));
    console.log(`[send-dunning] overdue=${overdue.length} filtered=${filteredOverdue.length}`);

    const overdueCommitments = await getCommitmentsByInvoices(filteredOverdue.map(i => i.invoice_number));
    const overduePhones = await getPhonesByContactIds(filteredOverdue.map(i => i.contact_id));

    for (const [, group] of groupByCustomer(filteredOverdue)) {
      try {
        const actionable = group.filter(i => {
          const c = overdueCommitments.get(i.invoice_number);
          return !c || c.template_step < 2;
        });
        if (!actionable.length) continue;
        const phone = overduePhones.get(actionable[0].contact_id);
        if (!phone) continue;

        const total = actionable.reduce((s, i) => s + i.balance, 0);
        const invStr = invoiceList(actionable);
        const earliestDue = actionable.reduce((a, b) => a.due_date < b.due_date ? a : b).due_date;

        if (!dryRun) {
          for (const inv of actionable) {
            const existing = overdueCommitments.get(inv.invoice_number);
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
          }
          await sendTemplate(phone, 'payment_overdue_collect', 'en', [
            actionable[0].customer_name,
            invStr,
            fmtAmount(total),
            fmtDate(earliestDue),
            COMPANY(),
          ]);
        }
        preview.push(`[overdue] ${actionable[0].customer_name} | ${invStr} | AED ${fmtAmount(total)} → ${phone}`);
        sent++;
      } catch (err: any) {
        errors.push(`overdue/${group[0].contact_id}: ${err?.message}`);
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

  res.json({ sent, advanced, finalized, elapsed_ms: elapsed, errors });
}
