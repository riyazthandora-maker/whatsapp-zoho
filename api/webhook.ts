import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  verifySignature,
  sendText,
  uploadMedia,
  sendDocument,
  markAsRead,
} from '../lib/whatsapp';
import { getAuthorizedRep } from '../lib/auth';
import { getSession, setSession, clearSession } from '../lib/session';
import { parseIntent } from '../lib/gemini';
import { findCustomers } from '../lib/customers';
import { getContactSummary, getStatementPdf, searchItems, getOutstandingInvoices } from '../lib/zoho';
import { logStatement } from '../lib/audit';
import {
  parseAdminCommand,
  addRep,
  removeRep,
  listReps,
  getRecentAudit,
  runSync,
  getAdminTasks,
  getAdminTasksForRep,
  addAllowedPhones,
  setAllowAll,
  setAllowList,
  getAllowStatus,
  clearAllowedPhones,
  ADMIN_HELP,
} from '../lib/admin';
import {
  getDunningSession,
  setDunningSession,
  clearDunningSession,
  getCommitmentById,
  getCommitmentsByPhone,
  getLatestCommitmentByPhone,
  selectCommitmentForMessage,
  getRepById,
  updateCommitment,
  updateCommitmentByInvoice,
  addConversationMessage,
  getConversationHistory,
  createRepTask,
  getOpenRepTasks,
  getTaskById,
  getTaskList,
  setTaskList,
  updateRepTask,
  normalizePhone,
} from '../lib/dunning';
import { manageDunningReply } from '../lib/dunning-gemini';
import { resolveCommittedDate, dubaiTodayISO } from '../lib/dates';
import type {
  Session,
  SalesRep,
  CustomerMatch,
  WhatsAppMessage,
  DunningSessionData,
  RepTask,
} from '../types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    return handleVerification(req, res);
  }
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-hub-signature-256'] as string;
  if (!verifySignature(JSON.stringify(req.body), signature)) {
    return res.status(401).end();
  }

  const value = req.body?.entry?.[0]?.changes?.[0]?.value ?? {};
  const messages: WhatsAppMessage[] = value.messages ?? [];

  if (!messages.length) return res.status(200).end();

  const message = messages[0];
  const phone = message.from;

  // Voice/audio message — notify dunning customers, ignore everyone else
  if (message.type === 'audio') {
    const normPhone = normalizePhone(phone);
    const dunningSession = await getDunningSession(normPhone);
    const pending = dunningSession ? true : (await getCommitmentsByPhone(normPhone)).length > 0;
    if (pending) {
      await sendText(phone, "We don't listen to voice messages. Please type your reply.");
    }
    return res.status(200).end();
  }

  if (message.type !== 'text' && message.type !== 'button') return res.status(200).end();

  const text =
    message.type === 'button'
      ? (message.button?.text ?? '')
      : (message.text?.body?.trim() ?? '');

  if (!text) return res.status(200).end();

  markAsRead(message.id).catch((err: any) =>
    console.error('[whatsapp] markAsRead non-fatal:', err?.message)
  );

  try {
    const rep = await getAuthorizedRep(phone);

    if (!rep) {
      const normPhone = normalizePhone(phone);

      // Customer asked for their statement — serve it if we have a commitment on file
      if (isStatementRequest(text)) {
        const commitment = await getLatestCommitmentByPhone(normPhone);
        if (commitment) {
          await deliverCustomerStatement(phone, commitment.customer_zoho_id, commitment.customer_name);
        }
        return res.status(200).end();
      }

      const dunningSession = await getDunningSession(normPhone);
      const activeCommitments = await getCommitmentsByPhone(normPhone);

      // A bare greeting must not re-pitch an invoice we're already handling
      if ((dunningSession || activeCommitments.length > 0) && isGreeting(text)) {
        const alreadyEngaged =
          !!dunningSession || activeCommitments.some(c => c.customer_replied_at);
        if (alreadyEngaged) {
          const name = (await getCommitmentById(dunningSession?.commitmentId ?? activeCommitments[0].id))?.customer_name;
          await sendText(phone, greetingAck(name));
          return res.status(200).end();
        }
      }

      // Active dunning AI conversation (Redis session exists)
      if (dunningSession) {
        await handleDunningReply(normPhone, text, dunningSession);
        return res.status(200).end();
      }

      // First reply to a dunning template (no Redis session yet)
      if (activeCommitments.length > 0) {
        const matched = selectCommitmentForMessage(text, activeCommitments);
        const freshSession: DunningSessionData = {
          commitmentId: matched!.id,
          exchangeCount: 0,
          unclearStreak: 0,
        };
        await handleDunningReply(normPhone, text, freshSession);
        return res.status(200).end();
      }

      // Unknown number — silently ignore
      return res.status(200).end();
    }

    const session: Session = (await getSession(phone)) ?? {
      state: 'idle',
      repId: rep.id,
      repName: rep.name,
    };

    await dispatch(phone, text, session, rep);
    return res.status(200).end();
  } catch (err: any) {
    console.error('[webhook] error:', phone, '|', text, '|', err?.message ?? err);
    return res.status(200).end();
  }
}

function handleVerification(req: VercelRequest, res: VercelResponse) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).end();
}

// ── State machine dispatcher ──────────────────────────────────────────────────

async function dispatch(phone: string, text: string, session: Session, rep: SalesRep) {
  // Admin commands take priority
  if (rep.role === 'admin') {
    const cmd = parseAdminCommand(text);
    if (cmd.type !== 'unknown') {
      if (session.state !== 'idle') await clearSession(phone);
      return handleAdminCommand(phone, cmd);
    }
  }

  // Tasks of <name> — available to all reps, not just admins
  const tasksOfMatch = text.trim().match(/^tasks\s+of\s+(.+)$/i);
  if (tasksOfMatch) {
    return sendText(phone, await getAdminTasksForRep(tasksOfMatch[1].trim()));
  }

  // Rep task commands (TASKS, DONE N, BROKEN N, CALL N, NOTE N <text>)
  const taskCmd = parseTaskCommand(text);
  if (taskCmd.type !== 'unknown') {
    return handleTaskCommand(phone, taskCmd, rep.id);
  }

  // Stock command
  const stockMatch = /^stock\s+(.+)/i.exec(text);
  if (stockMatch) {
    if (session.state !== 'idle') await clearSession(phone);
    return handleStockCommand(phone, stockMatch[1].trim(), session.repName);
  }

  switch (session.state) {
    case 'idle':
      return onIdle(phone, text, session);
    case 'awaiting_customer':
      return onAwaitingCustomer(phone, text, session);
    case 'awaiting_customer_selection':
      return onAwaitingSelection(phone, text, session);
    case 'awaiting_retry':
      return onAwaitingRetry(phone, text, session);
  }
}

// ── Admin command handler ─────────────────────────────────────────────────────

async function handleAdminCommand(phone: string, cmd: ReturnType<typeof parseAdminCommand>) {
  switch (cmd.type) {
    case 'add_rep':   return sendText(phone, await addRep(cmd.name, cmd.phone));
    case 'remove_rep': return sendText(phone, await removeRep(cmd.phone));
    case 'list_reps': return sendText(phone, await listReps());
    case 'audit':     return sendText(phone, await getRecentAudit(cmd.limit));
    case 'tasks':        return sendText(phone, await getAdminTasks());
    case 'tasks_of':     return sendText(phone, await getAdminTasksForRep(cmd.name));
    case 'allow_phones': return sendText(phone, await addAllowedPhones(cmd.raw));
    case 'allow_all':    return sendText(phone, await setAllowAll());
    case 'allow_on':     return sendText(phone, await setAllowList());
    case 'allow_status': return sendText(phone, await getAllowStatus());
    case 'allow_clear':  return sendText(phone, await clearAllowedPhones());
    case 'sync': {
      await sendText(phone, 'Syncing customers from Zoho...');
      return sendText(phone, await runSync());
    }
    case 'help': return sendText(phone, ADMIN_HELP);
  }
}

// ── Rep task commands ─────────────────────────────────────────────────────────

type TaskCommand =
  | { type: 'tasks' }
  | { type: 'done';   index: number }
  | { type: 'broken'; index: number }
  | { type: 'call';   index: number }
  | { type: 'note';   index: number; text: string }
  | { type: 'commit'; index: number; date: string }
  | { type: 'unknown' };

function parseCommitDate(raw: string): string | null {
  const s = raw.trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM or DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (dmy) {
    const year = dmy[3] ? parseInt(dmy[3], 10) : new Date().getFullYear();
    const d = new Date(year, parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10));
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  // DD Mon or DD Mon YYYY  (e.g. "15 Nov" or "15 Nov 2026")
  const dm = s.match(/^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/);
  if (dm) {
    const year = dm[3] ? parseInt(dm[3], 10) : new Date().getFullYear();
    const d = new Date(`${dm[2]} ${dm[1]}, ${year}`);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  return null;
}

function parseTaskCommand(text: string): TaskCommand {
  const t = text.trim();
  if (/^tasks$/i.test(t)) return { type: 'tasks' };

  const doneMatch   = t.match(/^done\s+(\d+)$/i);
  if (doneMatch)   return { type: 'done',   index: parseInt(doneMatch[1], 10) };

  const brokenMatch = t.match(/^broken\s+(\d+)$/i);
  if (brokenMatch) return { type: 'broken', index: parseInt(brokenMatch[1], 10) };

  const callMatch   = t.match(/^call\s+(\d+)$/i);
  if (callMatch)   return { type: 'call',   index: parseInt(callMatch[1], 10) };

  const noteMatch   = t.match(/^note\s+(\d+)\s+(.+)$/i);
  if (noteMatch)   return { type: 'note',   index: parseInt(noteMatch[1], 10), text: noteMatch[2].trim() };

  const commitMatch = t.match(/^commit\s+(\d+)\s+(.+)$/i);
  if (commitMatch) {
    const date = parseCommitDate(commitMatch[2].trim());
    if (date) return { type: 'commit', index: parseInt(commitMatch[1], 10), date };
  }

  return { type: 'unknown' };
}

const fmtAED = (n: number) =>
  `AED ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function taskIcon(type: string) { return type === 'collection' ? '📞' : type === 'escalation' ? '🚨' : '🔔'; }
function taskLabel(type: string) { return type === 'collection' ? 'Collect cheque' : type === 'escalation' ? 'Escalation' : 'Follow up'; }

function buildTaskList(tasks: RepTask[]): string {
  const lines = tasks.map((t, i) => {
    const due = t.due_date
      ? ` | Due: ${new Date(t.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`
      : '';
    const rep = t.rep_name ? ` | ${t.rep_name}` : '';
    return (
      `${i + 1}. ${taskIcon(t.task_type)} *${taskLabel(t.task_type)}* — ${t.customer_name}\n` +
      `   ${t.invoice_number} | ${fmtAED(t.amount)}${due}${rep}`
    );
  });
  return (
    `*Your Open Tasks (${tasks.length})*\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `_Commands: *DONE 1*, *BROKEN 1*, *COMMIT 1 15 Nov*, *CALL 1*, *NOTE 1 <text>*_`
  );
}

async function handleTaskCommand(
  phone: string,
  cmd: Exclude<TaskCommand, { type: 'unknown' }>,
  repId: string
) {
  if (cmd.type === 'tasks') {
    const tasks = await getOpenRepTasks(repId);
    if (!tasks.length) {
      await sendText(phone, 'No open tasks right now. 🎉');
      return;
    }
    await setTaskList(phone, tasks.map(t => t.id));
    await sendText(phone, buildTaskList(tasks));
    return;
  }

  const taskList = await getTaskList(phone);
  if (!taskList?.length) {
    await sendText(phone, 'No task list cached. Send *TASKS* first to load your tasks.');
    return;
  }

  const idx = cmd.index - 1;
  if (idx < 0 || idx >= taskList.length) {
    await sendText(phone, `Invalid number. You have ${taskList.length} task(s). Send *TASKS* to see them.`);
    return;
  }

  const taskId = taskList[idx];
  const task = await getTaskById(taskId);
  if (!task) {
    await sendText(phone, `Task ${cmd.index} not found. Send *TASKS* to refresh.`);
    return;
  }

  switch (cmd.type) {
    case 'done':
      await updateRepTask(taskId, { status: 'done' });
      await updateCommitmentStatus(task.invoice_number, 'collected');
      await sendText(phone, `✅ Task ${cmd.index} (*${task.customer_name}*) marked as collected.`);
      break;

    case 'broken':
      await updateRepTask(taskId, { status: 'broken' });
      await updateCommitmentStatus(task.invoice_number, 'broken');
      await sendText(phone, `❌ Task ${cmd.index} (*${task.customer_name}*) marked as broken commitment.`);
      break;

    case 'call': {
      const note = `Call attempted ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
      await updateRepTask(taskId, { status: 'noted', note });
      await sendText(phone, `📞 Call logged for task ${cmd.index} (*${task.customer_name}*).`);
      break;
    }

    case 'note':
      await updateRepTask(taskId, { status: 'noted', note: cmd.text });
      await sendText(phone, `📝 Note saved for task ${cmd.index} (*${task.customer_name}*).`);
      break;

    case 'commit': {
      const displayDate = new Date(cmd.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      await updateRepTask(taskId, { status: 'noted', note: `Rep: customer committed to pay on ${displayDate}`, due_date: cmd.date });
      await updateCommitmentByInvoice(task.invoice_number, { status: 'committed', committed_date: cmd.date });
      await sendText(phone, `📅 Task ${cmd.index} (*${task.customer_name}*) — committed date set to *${displayDate}*.`);
      break;
    }
  }
}

async function updateCommitmentStatus(invoiceNumber: string, status: string) {
  await updateCommitmentByInvoice(invoiceNumber, { status });
}

// ── Customer message helpers ──────────────────────────────────────────────────

const GREETING_RE =
  /^(hi+|hey+|hello+|salam|salaam|salam\s*alaikum|assalam[ou]?\s*alaikum|السلام\s*عليكم|مرحبا|أهلا|اهلا|नमस्ते|नमस्कार|हाय|हैलो)[\s!.,؟]*$/i;

function isGreeting(text: string): boolean {
  return GREETING_RE.test(text.trim());
}

const STATEMENT_RE = /statement|ledger|account statement|كشف\s*حساب|स्टेटमेंट|हिसाब/i;

function isStatementRequest(text: string): boolean {
  return STATEMENT_RE.test(text);
}

const CALL_REQUEST_RE =
  /\bcall\s+me\b|\bplease\s+call\b|\bgive\s+me\s+a\s+call\b|\bi\s+want\s+(?:you\s+to\s+)?call\b|call\s+instead|اتصل\s*بي|تصل\s*بي|कॉल\s*करें|मुझे\s*कॉल/i;

function isCallRequest(text: string): boolean {
  return CALL_REQUEST_RE.test(text.trim());
}

function greetingAck(name: string | undefined): string {
  return name
    ? `Hello ${name}, thanks for your message. Our team is handling your account — let us know if there's anything specific you need.`
    : `Hello, thanks for your message. Let us know if there's anything specific you need.`;
}

function handoffLine(name: string, phone: string | null, lang: string): string {
  const p = phone ? phone : null;
  switch (lang) {
    case 'ar':
      return p
        ? `سيتواصل معك مندوب المبيعات ${name} قريبًا. يمكنك التواصل معه على ${p}.`
        : `سيتواصل معك مندوب المبيعات ${name} قريبًا.`;
    case 'hi':
      return p
        ? `हमारे सेल्स प्रतिनिधि ${name} शीघ्र ही आपसे संपर्क करेंगे। आप उनसे ${p} पर संपर्क कर सकते हैं।`
        : `हमारे सेल्स प्रतिनिधि ${name} शीघ्र ही आपसे संपर्क करेंगे।`;
    default:
      return p
        ? `Our sales agent ${name} will contact you shortly. You can also reach them on ${p}.`
        : `Our sales agent ${name} will contact you shortly.`;
  }
}

function callRequestedHandoffMessage(name: string, phone: string | null, lang: string): string {
  const p = phone ?? null;
  switch (lang) {
    case 'ar':
      return p
        ? `شكرًا! سيتصل بك مندوب المبيعات ${name} قريبًا. للتواصل العاجل، يمكنك الاتصال به مباشرةً على ${p}.`
        : `شكرًا! سيتصل بك مندوب المبيعات ${name} قريبًا.`;
    case 'hi':
      return p
        ? `धन्यवाद! हमारे सेल्स प्रतिनिधि ${name} जल्द ही आपको कॉल करेंगे। अत्यावश्यक होने पर आप उन्हें ${p} पर सीधे संपर्क कर सकते हैं।`
        : `धन्यवाद! हमारे सेल्स प्रतिनिधि ${name} जल्द ही आपको कॉल करेंगे।`;
    default:
      return p
        ? `Thank you! Our sales agent ${name} will call you shortly. For urgent matters, you can reach them directly on ${p}.`
        : `Thank you! Our sales agent ${name} will call you shortly.`;
  }
}

function unclearHandoffMessage(name: string, phone: string | null, lang: string): string {
  const p = phone ? phone : null;
  switch (lang) {
    case 'ar':
      return p
        ? `عذرًا، لم أفهم طلبك. سيتواصل معك مندوب المبيعات ${name} قريبًا. يمكنك التواصل معه على ${p}.`
        : `عذرًا، لم أفهم طلبك. سيتواصل معك مندوب المبيعات ${name} قريبًا.`;
    case 'hi':
      return p
        ? `क्षमा करें, मैं आपका संदेश समझ नहीं पाया। हमारे सेल्स प्रतिनिधि ${name} शीघ्र ही आपसे संपर्क करेंगे। आप उनसे ${p} पर संपर्क कर सकते हैं।`
        : `क्षमा करें, मैं आपका संदेश समझ नहीं पाया। हमारे सेल्स प्रतिनिधि ${name} शीघ्र ही आपसे संपर्क करेंगे।`;
    default:
      return p
        ? `Sorry, I couldn't understand your request. Our sales agent ${name} will contact you shortly. You can also reach them on ${p}.`
        : `Sorry, I couldn't understand your request. Our sales agent ${name} will contact you shortly.`;
  }
}

// ── Dunning customer reply handler ────────────────────────────────────────────

async function handleDunningReply(
  phone: string,
  text: string,
  dunningSession: DunningSessionData
) {
  const { commitmentId, exchangeCount, unclearStreak = 0 } = dunningSession;

  const commitment = await getCommitmentById(commitmentId);
  if (!commitment) {
    await clearDunningSession(phone);
    return;
  }

  // Save customer message to conversation log
  await addConversationMessage(commitmentId, 'customer', text);

  // First reply — update commitment status
  if (!commitment.customer_replied_at) {
    await updateCommitment(commitmentId, {
      customer_replied_at: new Date().toISOString(),
      status: 'negotiating',
    });
  }

  // Fetch all active commitments for this phone for consolidated context
  const activeCommitments = await getCommitmentsByPhone(phone);
  const totalAmount = activeCommitments.reduce((s, c) => s + Number(c.amount), 0) || commitment.amount;
  const allInvoices = activeCommitments.map(c => c.invoice_number);
  const invoiceStr = allInvoices.length > 3
    ? allInvoices.slice(0, 3).join(', ') + '...'
    : allInvoices.join(', ') || commitment.invoice_number;

  // Load full conversation history (minus the message we just saved — pass it as latestMessage)
  const history = await getConversationHistory(commitmentId);

  // Resolve the assigned sales agent so handoffs can name a real person
  const repInfo = commitment.assigned_rep_id ? await getRepById(commitment.assigned_rep_id) : null;
  const repName = repInfo?.name ?? 'our sales team';
  const repPhone = repInfo?.whatsapp_number ?? process.env.DUNNING_REP_PHONE ?? null;

  // ── Call requested — bypass AI, thank customer, give rep's direct number ─────
  if (isCallRequest(text)) {
    const lastLang = [...history].reverse().find(h => h.language)?.language ?? 'en';
    const reply = callRequestedHandoffMessage(repName, repPhone, lastLang);
    await addConversationMessage(commitmentId, 'bot', reply, lastLang);
    await sendText(phone, reply);
    await updateCommitment(commitmentId, { exchange_count: exchangeCount + 1, status: 'escalated' });
    await createRepTask({
      rep_id: commitment.assigned_rep_id,
      customer_zoho_id: commitment.customer_zoho_id,
      customer_name: commitment.customer_name,
      invoice_number: commitment.invoice_number,
      amount: commitment.amount,
      task_type: 'escalation',
      note: 'Customer requested a call back',
    });
    await clearDunningSession(phone);
    return;
  }

  const aiResult = await manageDunningReply({
    customerName: commitment.customer_name,
    invoiceNumber: invoiceStr,
    amount: totalAmount,
    companyName: process.env.COMPANY_NAME || 'Our Company',
    history: history.slice(0, -1),
    latestMessage: text,
    exchangeCount,
    noCount: commitment.no_count,
    repName,
    unclearStreak,
  });

  const newExchangeCount = exchangeCount + 1;
  const baseUpdate: Record<string, unknown> = { exchange_count: newExchangeCount };
  if (aiResult.refused) baseUpdate.no_count = commitment.no_count + 1;

  // ── Unclear: apologise and ask to repeat; hand off after 2 in a row ──────────
  if (aiResult.status === 'unclear') {
    const newStreak = unclearStreak + 1;
    if (newStreak < 2) {
      await addConversationMessage(commitmentId, 'bot', aiResult.reply, aiResult.languageDetected);
      await sendText(phone, aiResult.reply);
      await updateCommitment(commitmentId, { ...baseUpdate, status: 'negotiating' });
      await setDunningSession(phone, { commitmentId, exchangeCount: newExchangeCount, unclearStreak: newStreak });
      return;
    }
    // Second miss — hand off to the sales agent with their number
    const reply = unclearHandoffMessage(repName, repPhone, aiResult.languageDetected);
    await addConversationMessage(commitmentId, 'bot', reply, aiResult.languageDetected);
    await sendText(phone, reply);
    await updateCommitment(commitmentId, { ...baseUpdate, status: 'escalated' });
    await createRepTask({
      rep_id: commitment.assigned_rep_id,
      customer_zoho_id: commitment.customer_zoho_id,
      customer_name: commitment.customer_name,
      invoice_number: commitment.invoice_number,
      amount: commitment.amount,
      task_type: 'escalation',
      note: 'Could not understand customer after 2 messages',
    });
    await clearDunningSession(phone);
    return;
  }

  // ── Clear cases — reset the unclear streak ───────────────────────────────────
  let reply = aiResult.reply;
  if (aiResult.status === 'escalate') {
    reply = `${reply}\n\n${handoffLine(repName, repPhone, aiResult.languageDetected)}`;
  }
  await addConversationMessage(commitmentId, 'bot', reply, aiResult.languageDetected);
  await sendText(phone, reply);

  if (aiResult.status === 'committed') {
    const todayISO = dubaiTodayISO();
    const modelDate =
      aiResult.committedDate && /^\d{4}-\d{2}-\d{2}$/.test(aiResult.committedDate)
        ? aiResult.committedDate
        : null;
    // The code-computed date from the customer's own words is authoritative.
    const resolved =
      resolveCommittedDate(aiResult.committedDatePhrase)
      ?? (modelDate && modelDate >= todayISO ? modelDate : null);

    if (!resolved) {
      // No date we can trust in the future — keep it soft, never create a bad rep task.
      await updateCommitment(commitmentId, { ...baseUpdate, status: 'soft_commitment' });
      await setDunningSession(phone, { commitmentId, exchangeCount: newExchangeCount, unclearStreak: 0 });
      return;
    }

    await updateCommitment(commitmentId, { ...baseUpdate, status: 'committed', committed_date: resolved });
    await createRepTask({
      rep_id: commitment.assigned_rep_id,
      customer_zoho_id: commitment.customer_zoho_id,
      customer_name: commitment.customer_name,
      invoice_number: commitment.invoice_number,
      amount: commitment.amount,
      task_type: 'escalation',
      due_date: resolved,
      note: `Customer committed to pay on ${resolved}. Call to confirm payment arrangements.`,
    });
    await clearDunningSession(phone);

  } else if (aiResult.status === 'escalate') {
    await updateCommitment(commitmentId, { ...baseUpdate, status: 'escalated' });
    await createRepTask({
      rep_id: commitment.assigned_rep_id,
      customer_zoho_id: commitment.customer_zoho_id,
      customer_name: commitment.customer_name,
      invoice_number: commitment.invoice_number,
      amount: commitment.amount,
      task_type: 'escalation',
      note: aiResult.reason ?? 'Escalated by AI',
    });
    await clearDunningSession(phone);

  } else if (aiResult.status === 'soft_commitment') {
    await updateCommitment(commitmentId, { ...baseUpdate, status: 'soft_commitment' });
    await setDunningSession(phone, { commitmentId, exchangeCount: newExchangeCount, unclearStreak: 0 });

  } else if (aiResult.status === 'closed') {
    await updateCommitment(commitmentId, { ...baseUpdate, status: 'declined' });
    await clearDunningSession(phone);

  } else {
    // ongoing — continue conversation
    await updateCommitment(commitmentId, { ...baseUpdate, status: 'negotiating' });
    await setDunningSession(phone, { commitmentId, exchangeCount: newExchangeCount, unclearStreak: 0 });
  }
}

// ── Stock command handler ─────────────────────────────────────────────────────

async function handleStockCommand(phone: string, query: string, repName: string) {
  await sendText(phone, `Searching stock for *"${query}"*...`);
  try {
    const items = await searchItems(query);
    if (items.length === 0) {
      await sendText(phone, `No products found matching *"${query}"*.`);
      return;
    }
    const lines = items.map((item, i) => {
      const qty = item.stock_on_hand !== null ? `${item.stock_on_hand} units` : 'N/A';
      const flag = item.stock_on_hand === 0 ? ' ⚠️' : '';
      return `${i + 1}. *${item.name}*\n   Stock: ${qty}${flag}`;
    });
    const count = items.length;
    await sendText(
      phone,
      `📦 *Stock: "${query}"*\n\n${lines.join('\n\n')}\n\n_${count} product${count === 1 ? '' : 's'} found_`
    );
  } catch (err) {
    console.error('[webhook] stock lookup error:', err);
    await sendText(phone, 'Could not fetch stock data. Please try again.');
  }
}

// ── Rep session handlers ──────────────────────────────────────────────────────

async function onIdle(phone: string, text: string, session: Session) {
  const intent = await parseIntent(text);

  if (intent.intent !== 'get_statement') {
    await sendText(
      phone,
      `Hi ${session.repName}! Here's what I can do:\n\n` +
        `📦 *Stock lookup*\n` +
        `\`Stock <product>\` — e.g. _"Stock cement"_\n\n` +
        `📄 *Customer statement*\n` +
        `_"Statement for Gulf Trading"_\n` +
        `_"Balance for Acme Corp"_\n\n` +
        `📋 *Task management*\n` +
        `\`TASKS\` — View your open tasks`
    );
    return;
  }

  if (!intent.customer_name) {
    await setSession(phone, { ...session, state: 'awaiting_customer' });
    await sendText(phone, 'Which customer would you like a statement for?');
    return;
  }

  await resolveCustomer(phone, intent.customer_name, session, [], 0);
}

async function onAwaitingCustomer(phone: string, text: string, session: Session) {
  const intent = await parseIntent(text);
  const query = (intent.intent === 'get_statement' && intent.customer_name)
    ? intent.customer_name
    : text;
  await resolveCustomer(phone, query, session, [], 0);
}

async function onAwaitingSelection(phone: string, text: string, session: Session) {
  if (/^more$/i.test(text.trim()) && session.customerQuery) {
    return resolveCustomer(
      phone,
      session.customerQuery,
      session,
      session.customerCandidates ?? [],
      session.customerOffset ?? 0
    );
  }

  const pick = parseInt(text.trim(), 10);
  const candidates: CustomerMatch[] = session.customerCandidates ?? [];

  if (isNaN(pick) || pick < 1 || pick > candidates.length) {
    const moreHint = session.customerOffset ? ' Type *more* for more results, or enter' : ' Reply with';
    await sendText(phone, `${moreHint} a number between 1 and ${candidates.length}.`);
    await setSession(phone, session);
    return;
  }

  const chosen = candidates[pick - 1];
  await clearSession(phone);
  await deliverStatement(phone, chosen.zoho_contact_id, chosen.name, session.repId, session.repName);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function resolveCustomer(
  phone: string,
  query: string,
  session: Session,
  existingCandidates: CustomerMatch[],
  offset: number
) {
  const { matches, hasMore } = await findCustomers(query, offset);

  if (matches.length === 0) {
    if (existingCandidates.length === 0) {
      await setSession(phone, { ...session, state: 'awaiting_customer' });
      await sendText(phone, `No customer found matching *"${query}"*. Please check the name and try again.`);
    } else {
      await sendText(phone, 'No more results.');
      await setSession(phone, session);
    }
    return;
  }

  const allCandidates = [...existingCandidates, ...matches];

  if (allCandidates.length === 1 && !hasMore) {
    await clearSession(phone);
    return deliverStatement(
      phone,
      allCandidates[0].zoho_contact_id,
      allCandidates[0].name,
      session.repId,
      session.repName
    );
  }

  const startNum = existingCandidates.length + 1;
  const list = matches.map((m, i) => `${startNum + i}. ${m.name}`).join('\n');
  const moreHint = hasMore ? '\n\nType *more* to see more results.' : '';
  const header = offset === 0 ? 'Multiple customers found. Reply with the number:\n\n' : 'More results:\n\n';

  await setSession(phone, {
    ...session,
    state: 'awaiting_customer_selection',
    customerCandidates: allCandidates,
    customerQuery: query,
    customerOffset: offset + matches.length,
  });
  await sendText(phone, `${header}${list}${moreHint}`);
}

async function sendStatementContent(
  phone: string,
  contactId: string,
  customerName: string,
  footer?: string
): Promise<'delivered' | 'failed'> {
  const now = new Date();
  const asOf = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  try {
    const [summary, pdfBuffer, allInvoices] = await Promise.all([
      getContactSummary(contactId),
      getStatementPdf(contactId),
      getOutstandingInvoices(contactId),
    ]);

    const sym = summary.currencySymbol;
    const fmt = (n: number) =>
      `${sym}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const today = new Date().toISOString().split('T')[0];
    const overdueInvoices = allInvoices.filter(inv => inv.due_date < today);

    let overdueBlock = '';
    if (overdueInvoices.length > 0) {
      const lines = overdueInvoices.map(inv => {
        const due = new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        return `*• ${inv.invoice_number} — ${fmt(inv.balance)} (due ${due})*`;
      });
      overdueBlock = `\n\n*Overdue Invoices:*\n${lines.join('\n')}`;
    }

    await sendText(
      phone,
      `📄 *${customerName}*\n\n` +
        `*Balance Due (As of ${asOf}): ${fmt(summary.balanceDue)}*` +
        `${overdueBlock}` +
        (footer ? `\n\n_${footer}_` : '')
    );

    if (pdfBuffer) {
      const filename = `Statement_${customerName.replace(/[^a-zA-Z0-9]/g, '_')}_${asOf.replace(/\s/g, '_')}.pdf`;
      const mediaId = await uploadMedia(pdfBuffer, filename);
      await sendDocument(phone, mediaId, filename, `${customerName} — Outstanding Statement`);
    }
    return 'delivered';
  } catch (err) {
    console.error('[webhook] sendStatementContent error:', err);
    return 'failed';
  }
}

async function deliverStatement(
  phone: string,
  contactId: string,
  customerName: string,
  repId: string,
  repName: string
) {
  await sendText(phone, `Fetching statement for *${customerName}*...`);

  const deliveryStatus = await sendStatementContent(phone, contactId, customerName, `Pulled by: ${repName}`);

  if (deliveryStatus === 'failed') {
    await sendText(phone, 'Sorry, I could not retrieve the statement right now. Reply *retry* to try again.');
    await setSession(phone, {
      state: 'awaiting_retry',
      repId,
      repName,
      resolvedCustomerId: contactId,
      resolvedCustomerName: customerName,
    });
  }

  await logStatement({
    repId,
    repName,
    repPhone: phone,
    customerZohoId: contactId,
    customerName,
    deliveryStatus,
  });
}

// Customer-initiated statement request (no rep identity — logged with null rep)
async function deliverCustomerStatement(phone: string, contactId: string, customerName: string) {
  const deliveryStatus = await sendStatementContent(phone, contactId, customerName);

  if (deliveryStatus === 'failed') {
    await sendText(phone, 'Sorry, we could not retrieve your statement right now. Our sales agent will contact you.');
  }

  await logStatement({
    repId: null,
    repName: null,
    repPhone: null,
    customerZohoId: contactId,
    customerName,
    deliveryStatus,
  });
}

async function onAwaitingRetry(phone: string, text: string, session: Session) {
  if (/^retry$/i.test(text.trim())) {
    await clearSession(phone);
    return deliverStatement(
      phone,
      session.resolvedCustomerId!,
      session.resolvedCustomerName!,
      session.repId,
      session.repName
    );
  }
  await clearSession(phone);
  return onIdle(phone, text, { ...session, state: 'idle' });
}
