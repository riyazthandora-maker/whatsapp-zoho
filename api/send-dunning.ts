import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase';
import { getOverdueInvoices, getUpcomingDueInvoices } from '../lib/zoho';
import { sendTemplate } from '../lib/whatsapp';
import {
  getCommitmentByInvoice,
  createCommitment,
  updateCommitment,
  getCommitmentsForFollowup,
  createRepTask,
} from '../lib/dunning';

const COMPANY = () => process.env.COMPANY_NAME || 'Our Company';

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

async function getCustomerPhone(zohoContactId: string): Promise<string | null> {
  const { data } = await supabase
    .from('zoho_customers')
    .select('phone')
    .eq('zoho_contact_id', zohoContactId)
    .maybeSingle();
  const phone = (data as { phone?: string } | null)?.phone;
  return phone?.trim() || null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dry_run === 'true';
  const repId = await getDefaultRepId();
  let sent = 0;
  let advanced = 0;
  let finalized = 0;
  const errors: string[] = [];
  const preview: string[] = [];

  // ── Step 1: Advance notice (due in 7 days) ────────────────────────────────
  try {
    const upcoming = await getUpcomingDueInvoices(7);
    for (const inv of upcoming) {
      try {
        const existing = await getCommitmentByInvoice(inv.invoice_number);
        if (existing) continue;

        const phone = await getCustomerPhone(inv.contact_id);
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
    const overdue = await getOverdueInvoices();
    for (const inv of overdue) {
      try {
        const existing = await getCommitmentByInvoice(inv.invoice_number);
        if (existing && existing.template_step >= 2) continue;

        const phone = await getCustomerPhone(inv.contact_id);
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

  console.log(`[send-dunning] dry_run=${dryRun} sent=${sent} advanced=${advanced} finalized=${finalized} errors=${errors.length}`);
  if (errors.length) console.error('[send-dunning] errors:', errors);

  res.json({ dry_run: dryRun, sent, advanced, finalized, errors, ...(dryRun && { preview }) });
}
