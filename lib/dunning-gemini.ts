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
  repName: string;
  unclearStreak: number;
}): Promise<DunningReply> {
  const { customerName, invoiceNumber, amount, companyName, history, latestMessage, exchangeCount, noCount, repName, unclearStreak } = params;

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
- Sales agent handling this customer: ${repName}
${maxExchangesReached ? '- NOTE: Maximum exchanges reached. Our sales agent must take over.' : ''}
${tooManyNos ? '- NOTE: Customer has refused 3+ times. Our sales agent must take over.' : ''}

Conversation so far:
${historyText}

Customer's latest message: "${latestMessage}"

Your rules:
1. Detect the language of the customer's latest message and reply in that EXACT language.
2. Goal: get a specific payment date commitment.
3. Specific date given → set status "committed", extract the date. refused=false.
4. Vague yes ("will pay", "shortly", "soon") → ask for a specific date, status "soft_commitment", refused=false.
5. Decline / can't pay / no money → empathize briefly, try partial payment or a later date, status "ongoing", refused=true.
6. Payment dispute ("already paid", "wrong invoice", "not my bill") → say our sales agent ${repName} will contact them to resolve it, status "escalate", refused=false.
7. Abusive or threatening language → say our sales agent ${repName} will contact them, status "escalate", refused=false.
8. If ${maxExchangesReached || tooManyNos ? 'immediately' : 'after 5+ exchanges without commitment'} → say our sales agent ${repName} will be in touch, status "escalate", refused=false.
9. If the conversation is clearly resolved with no further action → status "closed", refused=false.
10. If the message is unclear, gibberish, off-topic, or a question you cannot answer confidently (e.g. stock, prices, anything not about this payment) → reply with ONE short apology in the customer's language asking them to rephrase, set status "unclear", refused=false.
11. NEVER use the words "escalate" or "escalation" in any reply to the customer. Instead say our sales agent will contact them.
12. NEVER write any phone number in your reply — the system appends contact details automatically.

Reply ONLY with a raw JSON object (no markdown, no code fences):
{"reply":"your message in the customer's language","status":"ongoing|committed|soft_commitment|escalate|closed|unclear","committedDate":"YYYY-MM-DD or null","reason":"reason or null","languageDetected":"en|ar|hi|tl|ml|ur|...","refused":true|false}`;

  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const raw = response.text?.trim() ?? '';
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(text) as DunningReply;
    return { ...parsed, refused: parsed.refused === true };
  } catch (err) {
    console.error('[dunning-gemini] error:', err);
    return {
      reply: 'Thank you for your message. A team member will be in touch with you shortly.',
      status: 'escalate',
      committedDate: null,
      reason: 'Gemini error — auto-escalated to rep',
      languageDetected: 'en',
      refused: false,
    };
  }
}
