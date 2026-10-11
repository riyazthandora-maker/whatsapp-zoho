import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase';
import { sendText } from '../lib/whatsapp';
import { getOpenRepTasks, setTaskList } from '../lib/dunning';
import type { RepTask } from '../types';

const fmtAED = (n: number) =>
  `AED ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function taskIcon(type: string): string {
  if (type === 'collection') return '📞';
  if (type === 'escalation') return '🚨';
  return '🔔';
}

function taskLabel(type: string): string {
  if (type === 'collection') return 'Collect cheque';
  if (type === 'escalation') return 'Escalation';
  return 'Follow up';
}

function buildDigest(repName: string, tasks: RepTask[]): string {
  const lines = tasks.map((t, i) => {
    const due = t.due_date
      ? ` | Due: ${new Date(t.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`
      : '';
    const note = t.note ? `\n   _${t.note}_` : '';
    return (
      `${i + 1}. ${taskIcon(t.task_type)} *${taskLabel(t.task_type)}* — ${t.customer_name}\n` +
      `   ${t.invoice_number} | ${fmtAED(t.amount)}${due}${note}`
    );
  });

  return (
    `Good morning *${repName}*! 👋\n\n` +
    `*Your Open Tasks (${tasks.length})*\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `_Commands: *DONE 1*, *BROKEN 1*, *CALL 1*, *NOTE 1 <text>*, *TASKS*_`
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: reps } = await supabase
    .from('sales_reps')
    .select('id, name, whatsapp_number')
    .eq('is_active', true);

  if (!reps?.length) return res.json({ sent: 0 });

  let sent = 0;
  for (const rep of reps as { id: string; name: string; whatsapp_number: string }[]) {
    const tasks = await getOpenRepTasks(rep.id);
    if (!tasks.length) continue;

    await setTaskList(rep.whatsapp_number, tasks.map(t => t.id));
    await sendText(rep.whatsapp_number, buildDigest(rep.name, tasks));
    sent++;
  }

  console.log(`[morning-digest] sent to ${sent} rep(s)`);
  res.json({ sent });
}
