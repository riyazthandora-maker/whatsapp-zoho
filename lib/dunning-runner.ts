import { supabase } from './supabase';
import { getOverdueInvoices, getUpcomingDueInvoices } from './zoho';
import type { OverdueInvoice } from './zoho';
import { sendTemplate } from './whatsapp';
import {
  createCommitment,
  updateCommitment,
  getCommitmentsForFollowup,
  createRepTask,
  normalizePhone,
  getEffectiveRepIds,
  getDunningFilterMode,
  getAllowlistedPhones,
} from './dunning';
import type { CommitmentRecord } from '../types';

const COMPANY = () => process.env.COMPANY_NAME || 'Our Company';

const TERMINAL_STATUSES = new Set(['committed', 'collected', 'broken', 'escalated', 'declined']);

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

export interface DunningRunResult {
  sent: number;
  advanced: number;
  finalized: number;
  elapsed_ms: number;
  errors: string[];
  preview: string[];
}

export async function runDunningJob(): Promise<DunningRunResult> {
  const t0 = Date.now();

  const [filterMode, allowedPhones] = await Promise.all([
    getDunningFilterMode(),
    getAllowlistedPhones(),
  ]);
  const phoneFilterActive = filterMode === 'allowlist' && allowedPhones.size > 0;
  let sent = 0;
  let advanced = 0;
  let finalized = 0;
  const errors: string[] = [];
  const preview: string[] = [];

  let overdueCustomerNames = new Set<string>();
  try {
    const overdueAll = await getOverdueInvoices();
    const overduePhonesPre = await getPhonesByContactIds(overdueAll.map(i => i.contact_id));
    const filteredOD = phoneFilterActive
      ? overdueAll.filter(i => allowedPhones.has(overduePhonesPre.get(i.contact_id) ?? ''))
      : overdueAll;
    filteredOD.forEach(i => overdueCustomerNames.add(i.customer_name.trim().toUpperCase()));
  } catch { /* non-fatal */ }

  // Step 1: Advance notice (due in 7 days)
  try {
    const upcoming = await getUpcomingDueInvoices(7);
    const filteredUpcoming = upcoming.filter(
      i => !overdueCustomerNames.has(i.customer_name.trim().toUpperCase())
    );

    const upcomingCommitments = await getCommitmentsByInvoices(filteredUpcoming.map(i => i.invoice_number));
    const upcomingPhones = await getPhonesByContactIds(filteredUpcoming.map(i => i.contact_id));
    const upcomingReps = await getEffectiveRepIds(filteredUpcoming.map(i => i.contact_id));

    for (const [, group] of groupByCustomer(filteredUpcoming)) {
      try {
        const newInvoices = group.filter(i => !upcomingCommitments.has(i.invoice_number));
        if (!newInvoices.length) continue;
        const phone = upcomingPhones.get(newInvoices[0].contact_id);
        if (!phone) continue;
        if (phoneFilterActive && !allowedPhones.has(phone)) continue;

        const total = newInvoices.reduce((s, i) => s + i.balance, 0);
        const invStr = invoiceList(newInvoices);
        const earliestDue = newInvoices.reduce((a, b) => a.due_date < b.due_date ? a : b).due_date;

        for (const inv of newInvoices) {
          await createCommitment({
            customer_zoho_id: inv.contact_id,
            customer_name: inv.customer_name,
            customer_phone: phone,
            invoice_number: inv.invoice_number,
            amount: inv.balance,
            assigned_rep_id: upcomingReps.get(inv.contact_id) ?? null,
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
        preview.push(`[advance] ${newInvoices[0].customer_name} | ${invStr} | AED ${fmtAmount(total)} → ${phone}`);
        sent++;
      } catch (err: any) {
        errors.push(`advance/${group[0].contact_id}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`advance-fetch: ${err?.message}`);
  }

  // Step 2: Overdue notice
  try {
    const overdue = await getOverdueInvoices();
    overdueCustomerNames = new Set(overdue.map(i => i.customer_name.trim().toUpperCase()));

    const overdueCommitments = await getCommitmentsByInvoices(overdue.map(i => i.invoice_number));
    const overduePhones = await getPhonesByContactIds(overdue.map(i => i.contact_id));
    const overdueReps = await getEffectiveRepIds(overdue.map(i => i.contact_id));

    for (const [, group] of groupByCustomer(overdue)) {
      try {
        const actionable = group.filter(i => {
          const c = overdueCommitments.get(i.invoice_number);
          if (!c) return true;
          if (TERMINAL_STATUSES.has(c.status)) return false;
          return c.template_step < 2;
        });
        if (!actionable.length) continue;
        const phone = overduePhones.get(actionable[0].contact_id);
        if (!phone) continue;
        if (phoneFilterActive && !allowedPhones.has(phone)) continue;

        const total = actionable.reduce((s, i) => s + i.balance, 0);
        const invStr = invoiceList(actionable);
        const earliestDue = actionable.reduce((a, b) => a.due_date < b.due_date ? a : b).due_date;

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
              assigned_rep_id: overdueReps.get(inv.contact_id) ?? null,
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
        preview.push(`[overdue] ${actionable[0].customer_name} | ${invStr} | AED ${fmtAmount(total)} → ${phone}`);
        sent++;
      } catch (err: any) {
        errors.push(`overdue/${group[0].contact_id}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`overdue-fetch: ${err?.message}`);
  }

  // Step 3: Follow-up (step 2, no reply in 24h) — one message per customer
  try {
    const toFollow = await getCommitmentsForFollowup(2, 24);
    const followByPhone = new Map<string, CommitmentRecord[]>();
    for (const c of toFollow) {
      const list = followByPhone.get(c.customer_phone) ?? [];
      list.push(c);
      followByPhone.set(c.customer_phone, list);
    }
    for (const [phone, group] of followByPhone) {
      try {
        const total = group.reduce((s, c) => s + c.amount, 0);
        const invStr = invoiceList(group);
        for (const c of group) {
          await updateCommitment(c.id, {
            template_step: 3,
            template_sent_at: new Date().toISOString(),
          });
        }
        await sendTemplate(phone, 'payment_followup', 'en', [
          group[0].customer_name,
          invStr,
          fmtAmount(total),
          COMPANY(),
        ]);
        preview.push(`[followup] ${group[0].customer_name} | ${invStr} | AED ${fmtAmount(total)} → ${phone}`);
        advanced++;
      } catch (err: any) {
        errors.push(`followup/${phone}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`followup-fetch: ${err?.message}`);
  }

  // Step 4: Final notice (step 3, no reply in 72h) — one message + one task per customer
  try {
    const toFinalize = await getCommitmentsForFollowup(3, 72);
    const finalByPhone = new Map<string, CommitmentRecord[]>();
    for (const c of toFinalize) {
      const list = finalByPhone.get(c.customer_phone) ?? [];
      list.push(c);
      finalByPhone.set(c.customer_phone, list);
    }
    for (const [phone, group] of finalByPhone) {
      try {
        const total = group.reduce((s, c) => s + c.amount, 0);
        const invStr = invoiceList(group);
        const oldest = group.reduce((a, b) =>
          (a.template_sent_at ?? a.created_at) < (b.template_sent_at ?? b.created_at) ? a : b
        );
        const daysOverdue = Math.floor(
          (Date.now() - new Date(oldest.template_sent_at ?? oldest.created_at).getTime()) / 86_400_000
        );
        const taskDueDate = new Date();
        taskDueDate.setDate(taskDueDate.getDate() + 1);

        for (const c of group) {
          await updateCommitment(c.id, {
            template_step: 4,
            template_sent_at: new Date().toISOString(),
            status: 'escalated',
          });
        }
        const allInvoices = group.map(c => c.invoice_number).join(', ');
        await createRepTask({
          rep_id: group[0].assigned_rep_id,
          customer_zoho_id: group[0].customer_zoho_id,
          customer_name: group[0].customer_name,
          invoice_number: group[0].invoice_number,
          amount: total,
          task_type: 'escalation',
          due_date: taskDueDate.toISOString().split('T')[0],
          note: `No response after 3 WhatsApp messages (${daysOverdue}d overdue)${group.length > 1 ? ` | Invoices: ${allInvoices}` : ''}`,
        });
        await sendTemplate(phone, 'payment_final_notice', 'en', [
          group[0].customer_name,
          invStr,
          fmtAmount(total),
          String(daysOverdue),
          COMPANY(),
        ]);
        preview.push(`[final] ${group[0].customer_name} | ${invStr} | AED ${fmtAmount(total)} (${daysOverdue}d overdue) → ${phone}`);
        finalized++;
      } catch (err: any) {
        errors.push(`final/${phone}: ${err?.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`final-fetch: ${err?.message}`);
  }

  return { sent, advanced, finalized, elapsed_ms: Date.now() - t0, errors, preview };
}
