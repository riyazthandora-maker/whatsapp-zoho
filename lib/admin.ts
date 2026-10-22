import { supabase } from './supabase';
import { syncCustomers } from './sync';
import { getAllOpenTasks, getOpenTasksByRepName, addToAllowlist, setDunningFilterMode, clearAllowlist, getAllowlistedPhones, getDunningFilterMode, normalizePhone as normPhone } from './dunning';

export type AdminCommand =
  | { type: 'add_rep'; name: string; phone: string }
  | { type: 'remove_rep'; phone: string }
  | { type: 'list_reps' }
  | { type: 'audit'; limit: number }
  | { type: 'sync' }
  | { type: 'tasks' }
  | { type: 'tasks_of'; name: string }
  | { type: 'allow_phones'; raw: string }
  | { type: 'allow_all' }
  | { type: 'allow_on' }
  | { type: 'allow_status' }
  | { type: 'allow_clear' }
  | { type: 'help' }
  | { type: 'unknown' };

export function parseAdminCommand(text: string): AdminCommand {
  const t = text.trim();

  // add rep <Name>, <phone>
  const addMatch = t.match(/^add\s+rep\s+(.+),\s*(\+?\d[\d\s\-()+]{6,})/i);
  if (addMatch) {
    return {
      type: 'add_rep',
      name: addMatch[1].trim(),
      phone: normalizePhone(addMatch[2]),
    };
  }

  // remove rep <phone>
  const removeMatch = t.match(/^remove\s+rep\s+(\+?\d[\d\s\-()+]{6,})/i);
  if (removeMatch) {
    return { type: 'remove_rep', phone: normalizePhone(removeMatch[1]) };
  }

  if (/^(list|show)\s+reps?$/i.test(t)) return { type: 'list_reps' };

  const auditMatch = t.match(/^audit(?:\s+(\d+))?$/i);
  if (auditMatch) {
    return { type: 'audit', limit: auditMatch[1] ? parseInt(auditMatch[1], 10) : 10 };
  }

  if (/^sync$/i.test(t)) return { type: 'sync' };
  const tasksOfMatch = t.match(/^tasks\s+of\s+(.+)$/i);
  if (tasksOfMatch) return { type: 'tasks_of', name: tasksOfMatch[1].trim() };
  if (/^tasks$/i.test(t)) return { type: 'tasks' };
  if (/^allow\s+all$/i.test(t)) return { type: 'allow_all' };
  if (/^allow\s+on$/i.test(t)) return { type: 'allow_on' };
  if (/^allow\s+status$/i.test(t)) return { type: 'allow_status' };
  if (/^allow\s+clear$/i.test(t)) return { type: 'allow_clear' };
  const allowMatch = t.match(/^allow\s+(.+)$/i);
  if (allowMatch) return { type: 'allow_phones', raw: allowMatch[1] };
  if (/^(admin\s+)?help$/i.test(t)) return { type: 'help' };

  return { type: 'unknown' };
}

function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, '');
}

export async function addRep(name: string, phone: string): Promise<string> {
  const { error } = await supabase
    .from('sales_reps')
    .insert({ name, whatsapp_number: phone, role: 'rep', is_active: true });

  if (error) {
    if (error.code === '23505') return `${phone} is already registered.`;
    return `Failed to add rep: ${error.message}`;
  }

  return `Added *${name}* (${phone}) as a sales rep.`;
}

export async function removeRep(phone: string): Promise<string> {
  const { data, error } = await supabase
    .from('sales_reps')
    .update({ is_active: false })
    .eq('whatsapp_number', phone)
    .select('name')
    .single();

  if (error || !data) return `No active rep found with number ${phone}.`;

  return `Deactivated *${(data as { name: string }).name}* (${phone}).`;
}

export async function listReps(): Promise<string> {
  const { data, error } = await supabase
    .from('sales_reps')
    .select('name, whatsapp_number, role, is_active')
    .order('name');

  if (error || !data?.length) return 'No sales reps found.';

  type Row = { name: string; whatsapp_number: string; role: string; is_active: boolean };
  const lines = (data as Row[]).map((r) => {
    const tag = r.role === 'admin' ? ' _(admin)_' : '';
    const inactive = r.is_active ? '' : ' _(inactive)_';
    return `• *${r.name}*${tag} — ${r.whatsapp_number}${inactive}`;
  });

  return `*Sales Reps*\n\n${lines.join('\n')}`;
}

export async function getRecentAudit(limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit, 1), 25);

  const { data, error } = await supabase
    .from('audit_log')
    .select('rep_name, customer_name, statement_from, statement_to, requested_at, delivery_status')
    .order('requested_at', { ascending: false })
    .limit(safeLimit);

  if (error || !data?.length) return 'No audit entries found.';

  type Row = {
    rep_name: string;
    customer_name: string;
    statement_from: string;
    statement_to: string;
    requested_at: string;
    delivery_status: string;
  };

  const lines = (data as Row[]).map((r) => {
    const date = new Date(r.requested_at).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
    });
    const failed = r.delivery_status === 'failed' ? ' ✗' : '';
    return `• ${date} *${r.rep_name}*: ${r.customer_name} (${r.statement_from} → ${r.statement_to})${failed}`;
  });

  return `*Last ${safeLimit} Requests*\n\n${lines.join('\n')}`;
}

export async function runSync(): Promise<string> {
  try {
    const count = await syncCustomers();
    return `Synced *${count}* customers from Zoho.`;
  } catch (err) {
    console.error('Admin sync error:', err);
    return 'Sync failed. Check server logs.';
  }
}

const fmtAED = (n: number) =>
  `AED ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const taskIcon = (t: string) => t === 'collection' ? '📞' : t === 'escalation' ? '🚨' : '🔔';
const taskLabel = (t: string) => t === 'collection' ? 'Collect' : t === 'escalation' ? 'Escalation' : 'Follow up';

function formatTaskLines(tasks: Awaited<ReturnType<typeof getAllOpenTasks>>, startIndex = 0): string {
  return tasks.map((t, i) => {
    const due = t.due_date
      ? ` | ${new Date(t.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`
      : '';
    const rep = t.rep_name ? ` | ${t.rep_name}` : '';
    return `${startIndex + i + 1}. ${taskIcon(t.task_type)} *${taskLabel(t.task_type)}* — ${t.customer_name}\n   ${t.invoice_number} | ${fmtAED(t.amount)}${due}${rep}`;
  }).join('\n\n');
}

export async function getAdminTasks(): Promise<string> {
  const tasks = await getAllOpenTasks(25);
  if (!tasks.length) return 'No open tasks across all reps. 🎉';

  const total = tasks.reduce((sum, t) => sum + Number(t.amount), 0);
  return (
    `*All Open Tasks (${tasks.length})*\n\n` +
    `${formatTaskLines(tasks)}\n\n` +
    `_Total exposure: ${fmtAED(total)}_`
  );
}

export async function getAdminTasksForRep(name: string): Promise<string> {
  const { tasks, repName } = await getOpenTasksByRepName(name);
  if (!repName) return `No active rep found matching *"${name}"*.`;
  if (!tasks.length) return `No open tasks for *${repName}*. 🎉`;

  const total = tasks.reduce((sum, t) => sum + Number(t.amount), 0);
  return (
    `*Tasks for ${repName} (${tasks.length})*\n\n` +
    `${formatTaskLines(tasks)}\n\n` +
    `_Total exposure: ${fmtAED(total)}_`
  );
}

export async function addAllowedPhones(raw: string): Promise<string> {
  const phones = raw
    .split(',')
    .map(s => normPhone(s.trim()))
    .filter(p => p.length >= 7);

  if (!phones.length) return 'No valid phone numbers found. Use international format, comma-separated.';

  const added = await addToAllowlist(phones);
  const mode = await getDunningFilterMode();
  const modeNote = mode === 'all' ? '\n\n_Note: filter is currently OFF (allow all). Send *ALLOW STATUS* to check._' : '';
  return `✅ Added ${added} phone(s) to the dunning allowlist (${phones.length - added} already existed).${modeNote}`;
}

export async function setAllowAll(): Promise<string> {
  await setDunningFilterMode('all');
  return '🌐 Dunning filter disabled. Messages will be sent to *all* customers.';
}

export async function setAllowList(): Promise<string> {
  await setDunningFilterMode('allowlist');
  const phones = await getAllowlistedPhones();
  return `🔒 Dunning filter enabled. Messages will only be sent to *${phones.size}* phone(s) in the allowlist.`;
}

export async function getAllowStatus(): Promise<string> {
  const [mode, phones] = await Promise.all([getDunningFilterMode(), getAllowlistedPhones()]);
  const modeLabel = mode === 'all' ? '🌐 *Filter OFF* — sending to all customers' : `🔒 *Filter ON* — allowlist (${phones.size} phones)`;
  if (!phones.size) return `${modeLabel}\n\n_Allowlist is empty._`;
  const list = [...phones].sort().map(p => `• ${p}`).join('\n');
  return `${modeLabel}\n\n${list}`;
}

export async function clearAllowedPhones(): Promise<string> {
  await clearAllowlist();
  return '🗑️ Allowlist cleared. Add phones with *ALLOW <number>, <number>, ...*';
}

export const ADMIN_HELP =
  `*Admin Commands*\n\n` +
  `• \`add rep <Name>, <+phone>\` — Register a new rep\n` +
  `• \`remove rep <+phone>\` — Deactivate a rep\n` +
  `• \`list reps\` — Show all reps\n` +
  `• \`audit [N]\` — Last N requests (default 10)\n` +
  `• \`sync\` — Refresh Zoho customer list now\n` +
  `• \`tasks\` — View all open collection tasks (max 25)\n` +
  `• \`tasks of <name>\` — View tasks for a specific rep\n\n` +
  `*Dunning Filter*\n\n` +
  `• \`allow <+971...>, <+971...>\` — Add phones to allowlist\n` +
  `• \`allow all\` — Disable filter, send to all customers\n` +
  `• \`allow on\` — Re-enable the allowlist filter\n` +
  `• \`allow status\` — Show current filter mode + allowlist\n` +
  `• \`allow clear\` — Wipe the allowlist\n\n` +
  `*Rep Commands*\n\n` +
  `• \`Stock <product>\` — Show stock for matching products\n` +
  `• \`TASKS\` — View your open tasks\n` +
  `• \`DONE N\` — Mark task N as collected\n` +
  `• \`BROKEN N\` — Mark task N as broken commitment\n` +
  `• \`CALL N\` — Log a call attempt on task N\n` +
  `• \`NOTE N <text>\` — Add a note to task N\n` +
  `• _"Statement for Gulf Trading"_ — Send customer statement`;
