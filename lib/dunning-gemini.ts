import { GoogleGenAI } from '@google/genai';
import { buildDateContext } from './dates';
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

${buildDateContext()}

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
2. Goal: get a specific payment date commitment within the next 7 days.
3. Specific payment date given → set status "committed". Your reply MUST: (a) acknowledge the date they mentioned, (b) state clearly that you are not authorised to confirm payment arrangements, and (c) tell them that our sales agent ${repName} will contact them to confirm. Do NOT confirm or agree to the date yourself. Put the EXACT date words the customer used into "committedDatePhrase" (e.g. "next Tuesday", "15 Nov", "this weekend", "in two weeks"). Do NOT compute a calendar date yourself and ALWAYS set "committedDate" to null — the system resolves the phrase. refused=false.
3a. Every relative date resolves FORWARD from today (given above). Never a past date:
   - "tomorrow" → next day; "day after tomorrow" → +2 days
   - a weekday name or "next <weekday>" → the nearest upcoming such weekday (strictly after today)
   - "this weekend" / "end of the week" → the upcoming Friday
   - "next weekend" → the Saturday of the following week
   - "end of the month" → the last day of this month; "next month" → same day next month
   - "in N days/weeks" → today + N
   - an explicit date ("15 Nov", "15/11") → that date in the nearest future year
4. Vague yes ("will pay", "shortly", "soon") with no recognisable date → ask for a specific date within the next 7 days, status "soft_commitment", refused=false.
5. Decline / can't pay / no money → empathize briefly, try partial payment or a later date, status "ongoing", refused=true.
6. Payment dispute ("already paid", "wrong invoice", "not my bill") → say our sales agent ${repName} will contact them to resolve it, status "escalate", refused=false.
7. Abusive or threatening language → say our sales agent ${repName} will contact them, status "escalate", refused=false.
8. Customer explicitly asks to be called (e.g. "call me", "please call me", "can you call me", "give me a call", "I want to talk to someone", or any equivalent in their language) → reply "Thank you! Our sales agent ${repName} will call you shortly." in the customer's language, status "escalate", reason "call_requested", refused=false.
9. If ${maxExchangesReached || tooManyNos ? 'immediately' : 'after 5+ exchanges without commitment'} → say our sales agent ${repName} will be in touch, status "escalate", refused=false.
10. If the conversation is clearly resolved with no further action → status "closed", refused=false.
11. If the message is unclear, gibberish, off-topic, or a question you cannot answer confidently (e.g. stock, prices, who you are, your name, anything not about this payment) → reply in the customer's language with ALL of the following in one message: (a) introduce yourself as an AI chatbot created by ${companyName} to handle payment confirmations, (b) briefly mention that ${companyName} also provides IT services including custom AI chatbots like this one for businesses, and invite them to discuss their requirements with our sales agent, (c) give the sales agent's name (${repName}) and say they will be happy to help — do NOT write any phone number (the system appends it). Set status "unclear", refused=false.
12. NEVER use the words "escalate" or "escalation" in any reply to the customer. Instead say our sales agent will contact them.
13. NEVER write any phone number in your reply — the system appends contact details automatically.

Reply ONLY with a raw JSON object (no markdown, no code fences):
{"reply":"your message in the customer's language","status":"ongoing|committed|soft_commitment|escalate|closed|unclear","committedDatePhrase":"exact date words used by the customer, or null","committedDate":null,"reason":"reason or null","languageDetected":"en|ar|hi|tl|ml|ur|...","refused":true|false}`;

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
      committedDatePhrase: null,
      committedDate: null,
      reason: 'Gemini error — auto-escalated to rep',
      languageDetected: 'en',
      refused: false,
    };
  }
}
