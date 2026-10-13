import { Redis } from '@upstash/redis';
import { supabase } from './supabase';
import type { DunningSessionData, CommitmentRecord, RepTask } from '../types';

let _redis: Redis | null = null;
const getRedis = () => {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
};

const DUNNING_KEY = (phone: string) => `dunning:${phone}`;
const TASKLIST_KEY = (phone: string) => `tasklist:${phone}`;
const DUNNING_TTL = 7 * 24 * 60 * 60;   // 7 days
const TASKLIST_TTL = 24 * 60 * 60;       // 24 hours

// ── Dunning sessions (Redis) ──────────────────────────────────────────────────

export async function getDunningSession(phone: string): Promise<DunningSessionData | null> {
  return getRedis().get<DunningSessionData>(DUNNING_KEY(phone));
}

export async function setDunningSession(phone: string, data: DunningSessionData): Promise<void> {
  await getRedis().setex(DUNNING_KEY(phone), DUNNING_TTL, data);
}

export async function clearDunningSession(phone: string): Promise<void> {
  await getRedis().del(DUNNING_KEY(phone));
}

// ── Task list mapping (Redis) ─────────────────────────────────────────────────

export async function setTaskList(phone: string, taskIds: string[]): Promise<void> {
  await getRedis().setex(TASKLIST_KEY(phone), TASKLIST_TTL, taskIds);
}

export async function getTaskList(phone: string): Promise<string[] | null> {
  return getRedis().get<string[]>(TASKLIST_KEY(phone));
}

// ── Phone normalization ───────────────────────────────────────────────────────

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

// ── Collection commitments (Supabase) ─────────────────────────────────────────

export async function getCommitmentById(id: string): Promise<CommitmentRecord | null> {
  const { data } = await supabase
    .from('collection_commitments')
    .select('*')
    .eq('id', id)
    .single();
  return data as CommitmentRecord | null;
}

export async function getCommitmentByInvoice(invoiceNumber: string): Promise<CommitmentRecord | null> {
  const { data } = await supabase
    .from('collection_commitments')
    .select('*')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  return data as CommitmentRecord | null;
}

export async function getCommitmentsByPhone(phone: string): Promise<CommitmentRecord[]> {
  const norm = normalizePhone(phone);
  const { data } = await supabase
    .from('collection_commitments')
    .select('*')
    .eq('customer_phone', norm)
    .in('status', ['pending', 'negotiating', 'soft_commitment'])
    .order('created_at', { ascending: false });
  return (data ?? []) as CommitmentRecord[];
}

// Most recent commitment for a phone regardless of status (used to serve
// statements to customers who have already been contacted, even if committed/closed)
export async function getLatestCommitmentByPhone(phone: string): Promise<CommitmentRecord | null> {
  const norm = normalizePhone(phone);
  const { data } = await supabase
    .from('collection_commitments')
    .select('*')
    .eq('customer_phone', norm)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CommitmentRecord) ?? null;
}

// Pick which of a customer's active commitments an inbound message belongs to.
// 1) an invoice number named in the message  2) else the most recently templated one
export function selectCommitmentForMessage(
  text: string,
  commitments: CommitmentRecord[]
): CommitmentRecord | null {
  if (!commitments.length) return null;
  const upper = text.toUpperCase();
  const byInvoice = commitments.find(c => upper.includes(c.invoice_number.toUpperCase()));
  if (byInvoice) return byInvoice;
  const sorted = [...commitments].sort((a, b) =>
    (b.template_sent_at ?? b.created_at).localeCompare(a.template_sent_at ?? a.created_at)
  );
  return sorted[0];
}

export async function getRepById(
  id: string
): Promise<{ id: string; name: string; whatsapp_number: string } | null> {
  const { data } = await supabase
    .from('sales_reps')
    .select('id, name, whatsapp_number')
    .eq('id', id)
    .maybeSingle();
  return (data as { id: string; name: string; whatsapp_number: string }) ?? null;
}

// ── Rep routing ───────────────────────────────────────────────────────────────

// Last 9 digits — robust to country-code differences and typos (+971 vs +91 vs 0…)
function last9(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

// Map each customer's Zoho contact id to the sales rep who owns it.
// Match on sales-exec phone (last 9 digits) first, then exact name.
// Customers that don't map are simply omitted (caller treats them as unassigned).
export async function getEffectiveRepIds(contactIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!contactIds.length) return out;

  const repByPhone = new Map<string, string>();
  const repByName = new Map<string, string>();
  const { data: reps } = await supabase
    .from('sales_reps')
    .select('id, name, whatsapp_number')
    .eq('is_active', true);
  for (const r of (reps ?? []) as { id: string; name: string; whatsapp_number: string }[]) {
    const p = last9(r.whatsapp_number ?? '');
    if (p) repByPhone.set(p, r.id);
    repByName.set(r.name.trim().toLowerCase(), r.id);
  }

  const { data: custs } = await supabase
    .from('zoho_customers')
    .select('zoho_contact_id, sales_exec_phone, sales_exec_name')
    .in('zoho_contact_id', contactIds);

  for (const c of (custs ?? []) as {
    zoho_contact_id: string;
    sales_exec_phone: string | null;
    sales_exec_name: string | null;
  }[]) {
    const p = last9(c.sales_exec_phone ?? '');
    const repId = (p ? repByPhone.get(p) : undefined)
      ?? (c.sales_exec_name ? repByName.get(c.sales_exec_name.trim().toLowerCase()) : undefined);
    if (repId) out.set(c.zoho_contact_id, repId);
  }
  return out;
}

export async function createCommitment(data: {
  customer_zoho_id: string;
  customer_name: string;
  customer_phone: string;
  invoice_number: string;
  amount: number;
  assigned_rep_id: string | null;
  template_step: number;
}): Promise<{ id: string }> {
  const { data: row, error } = await supabase
    .from('collection_commitments')
    .insert({ ...data, template_sent_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw new Error(`createCommitment: ${error.message}`);
  return row as { id: string };
}

export async function updateCommitment(id: string, updates: Record<string, unknown>): Promise<void> {
  await supabase
    .from('collection_commitments')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
}

export async function getCommitmentsForFollowup(
  step: number,
  hoursOlderThan: number
): Promise<CommitmentRecord[]> {
  const cutoff = new Date(Date.now() - hoursOlderThan * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('collection_commitments')
    .select('*')
    .eq('template_step', step)
    .eq('status', 'pending')
    .is('customer_replied_at', null)
    .lt('template_sent_at', cutoff);
  return (data ?? []) as CommitmentRecord[];
}

// ── Dunning conversations (Supabase) ──────────────────────────────────────────

export async function addConversationMessage(
  commitmentId: string,
  role: 'bot' | 'customer',
  message: string,
  language?: string
): Promise<void> {
  await supabase.from('dunning_conversations').insert({
    commitment_id: commitmentId,
    role,
    message,
    language: language ?? null,
  });
}

export async function getConversationHistory(
  commitmentId: string
): Promise<{ role: string; message: string; language: string | null }[]> {
  const { data } = await supabase
    .from('dunning_conversations')
    .select('role, message, language')
    .eq('commitment_id', commitmentId)
    .order('created_at', { ascending: true });
  return (data ?? []) as { role: string; message: string; language: string | null }[];
}

// ── Rep tasks (Supabase) ──────────────────────────────────────────────────────

export async function createRepTask(data: {
  rep_id: string | null;
  customer_zoho_id: string;
  customer_name: string;
  invoice_number: string;
  amount: number;
  task_type: 'collection' | 'escalation' | 'follow_up';
  due_date?: string | null;
  note?: string | null;
}): Promise<{ id: string }> {
  const { data: row, error } = await supabase
    .from('rep_tasks')
    .insert(data)
    .select('id')
    .single();
  if (error) throw new Error(`createRepTask: ${error.message}`);
  return row as { id: string };
}

export async function getTaskById(taskId: string): Promise<RepTask | null> {
  const { data } = await supabase
    .from('rep_tasks')
    .select('*')
    .eq('id', taskId)
    .single();
  return data as RepTask | null;
}

export async function getOpenRepTasks(repId: string): Promise<RepTask[]> {
  const { data } = await supabase
    .from('rep_tasks')
    .select('*')
    .eq('rep_id', repId)
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  return (data ?? []) as RepTask[];
}

export async function getAllOpenTasks(limit = 0): Promise<RepTask[]> {
  let q = supabase
    .from('rep_tasks')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (limit > 0) q = q.limit(limit);
  const { data } = await q;
  return (data ?? []) as RepTask[];
}

export async function getOpenTasksByRepName(
  name: string
): Promise<{ tasks: RepTask[]; repName: string | null }> {
  const { data: rep } = await supabase
    .from('sales_reps')
    .select('id, name')
    .ilike('name', `%${name}%`)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (!rep) return { tasks: [], repName: null };
  const r = rep as { id: string; name: string };
  const tasks = await getOpenRepTasks(r.id);
  return { tasks, repName: r.name };
}

export async function updateRepTask(taskId: string, updates: Partial<RepTask>): Promise<void> {
  await supabase
    .from('rep_tasks')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', taskId);
}

export async function updateCommitmentByInvoice(
  invoiceNumber: string,
  updates: Record<string, unknown>
): Promise<void> {
  await supabase
    .from('collection_commitments')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('invoice_number', invoiceNumber);
}
