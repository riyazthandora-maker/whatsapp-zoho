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
import { getContactSummary, getStatementPdf, searchItems } from '../lib/zoho';
import { logStatement } from '../lib/audit';
import {
  parseAdminCommand,
  addRep,
  removeRep,
  listReps,
  getRecentAudit,
  runSync,
  ADMIN_HELP,
} from '../lib/admin';
import type { Session, SalesRep, CustomerMatch, WhatsAppMessage } from '../types';

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
  if (message.type !== 'text') return res.status(200).end();

  const phone = message.from;
  const text = message.text?.body?.trim() ?? '';

  markAsRead(message.id).catch((err: any) =>
    console.error('[whatsapp] markAsRead non-fatal:', err?.message)
  );

  try {
    const rep = await getAuthorizedRep(phone);
    if (!rep) {
      await sendText(
        phone,
        'This service is restricted to authorized sales representatives. Contact your manager to request access.'
      );
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
  // Admin commands take priority regardless of current session state
  if (rep.role === 'admin') {
    const cmd = parseAdminCommand(text);
    if (cmd.type !== 'unknown') {
      if (session.state !== 'idle') await clearSession(phone);
      return handleAdminCommand(phone, cmd);
    }
  }

  // Stock command available to all authorized reps
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

async function handleAdminCommand(phone: string, cmd: ReturnType<typeof parseAdminCommand>) {
  switch (cmd.type) {
    case 'add_rep': return sendText(phone, await addRep(cmd.name, cmd.phone));
    case 'remove_rep': return sendText(phone, await removeRep(cmd.phone));
    case 'list_reps': return sendText(phone, await listReps());
    case 'audit': return sendText(phone, await getRecentAudit(cmd.limit));
    case 'sync': {
      await sendText(phone, 'Syncing customers from Zoho...');
      return sendText(phone, await runSync());
    }
    case 'help': return sendText(phone, ADMIN_HELP);
  }
}

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

// ── Handlers ──────────────────────────────────────────────────────────────────

async function onIdle(phone: string, text: string, session: Session) {
  const intent = await parseIntent(text);

  if (intent.intent !== 'get_statement') {
    await sendText(
      phone,
      `Hi ${session.repName}! I send customer account statements.\n\n` +
        `Try: _"Statement for Gulf Trading"_\n` +
        `or: _"Balance for Acme Corp"_`
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
  // If user sends a full phrase ("statement for X"), extract just the name
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

async function deliverStatement(
  phone: string,
  contactId: string,
  customerName: string,
  repId: string,
  repName: string
) {
  await sendText(phone, `Fetching statement for *${customerName}*...`);

  const now = new Date();
  const asOf = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  let deliveryStatus: 'delivered' | 'failed' = 'delivered';

  try {
    const [summary, pdfBuffer] = await Promise.all([
      getContactSummary(contactId),
      getStatementPdf(contactId),
    ]);

    const sym = summary.currencySymbol;
    const fmt = (n: number) =>
      `${sym}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    await sendText(
      phone,
      `📄 *${customerName}*\n\n` +
        `*Balance Due (As of ${asOf}): ${fmt(summary.balanceDue)}*\n\n` +
        `_Pulled by: ${repName}_`
    );

    if (pdfBuffer) {
      const filename = `Statement_${customerName.replace(/[^a-zA-Z0-9]/g, '_')}_${asOf.replace(/\s/g, '_')}.pdf`;
      const mediaId = await uploadMedia(pdfBuffer, filename);
      await sendDocument(phone, mediaId, filename, `${customerName} — Outstanding Statement`);
    }
  } catch (err) {
    console.error('[webhook] deliverStatement error:', err);
    deliveryStatus = 'failed';
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
