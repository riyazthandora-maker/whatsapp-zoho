import { GoogleGenAI } from '@google/genai';
import type { DunningReply } from '../types';

const getAI = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function manageDunningReply(params: {
  customerName: string;
  invoiceNumber: string;
  amount: number;
  companyName: string;
  history: { role: string; message: string }[];
  latestMessage: string;
  exchangeCount: number;
  noCount: number;
}): Promise<DunningReply> {
  const { customerName, invoiceNumber, amount, companyName, history, latestMessage, exchangeCount, noCount } = params;

  const historyText = history.length
    ? history.map(h => `${h.role === 'bot' ? 'Us' : 'Customer'}: ${h.message}`).join('\n')
    : '(no prior messages)';

  const maxExchangesReached = exchangeCount >= 5;
  const tooManyNos = noCount >= 3;

  const prompt = `You are a polite but firm payment follow-up assistant for ${companyName}, a UAE trading company.
You are managing a WhatsApp conversation to collect an overdue invoice payment.

Context:
- Customer: ${customerName}
- Invoice: ${invoiceNumber}
- Amount: AED ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Previous exchanges: ${exchangeCount}
- Times customer said no/can't pay: ${noCount}
${maxExchangesReached ? '- NOTE: Maximum exchanges reached. Our sales staff will follow up directly.' : ''}
${tooManyNos ? '- NOTE: Customer has refused 3+ times. Our sales staff will follow up directly.' : ''}

Conversation so far:
${historyText}

Customer's latest message: "${latestMessage}"

Your rules:
1. Detect the language of the customer's latest message and reply in that EXACT language.
2. Goal: get a specific payment date commitment.
3. Specific date given → set status "committed", extract the date.
4. Vague yes ("will pay", "shortly", "soon") → ask for a specific date, status "soft_commitment".
5. Decline/can't pay → empathize, try partial payment or a later date, status "ongoing". Keep it brief.
6. Dispute ("already paid", "wrong invoice", "not my bill") → tell them our sales staff will contact them to resolve it, status "escalate".
7. Abusive or threatening language → tell them our sales staff will contact them, status "escalate".
8. If ${maxExchangesReached || tooManyNos ? 'immediately' : 'after 5+ exchanges without commitment'} → tell them our sales staff will be in touch, status "escalate".
9. If conversation is clearly resolved with no further action → status "closed".
10. If the message is unclear, gibberish, or you cannot understand it → reply exactly "Sorry, I didn't get that. Could you please repeat?" in the same language, status "ongoing".
11. NEVER use the word "escalate" or "escalation" in any reply to the customer. Instead say "our sales staff will contact you".

Reply ONLY with a raw JSON object (no markdown, no code fences):
{"reply":"your message in the customer's language","status":"ongoing|committed|soft_commitment|escalate|closed","committedDate":"YYYY-MM-DD or null","reason":"reason or null","languageDetected":"en|ar|hi|tl|ml|ur|..."}`;

  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const raw = response.text?.trim() ?? '';
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(text) as DunningReply;
  } catch (err) {
    console.error('[dunning-gemini] error:', err);
    return {
      reply: 'Thank you for your message. A team member will be in touch with you shortly.',
      status: 'escalate',
      committedDate: null,
      reason: 'Gemini error — auto-escalated to rep',
      languageDetected: 'en',
    };
  }
}
