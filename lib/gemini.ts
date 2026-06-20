import { GoogleGenAI } from '@google/genai';
import type { ParsedIntent } from '../types';

const getAI = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const PROMPT = (message: string) => `You are parsing a sales rep's WhatsApp message requesting a customer account summary.

Extract:
- intent: "get_statement" if they want a statement, balance, overdue, or account summary — otherwise "unknown"
- customer_name: the customer or company name they mentioned, or null

Message: "${message}"

Reply ONLY with a raw JSON object. No markdown, no code fences.
Example: {"intent":"get_statement","customer_name":"Gulf Trading"}`;

export async function parseIntent(message: string): Promise<ParsedIntent> {
  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: PROMPT(message),
    });

    const raw = response.text?.trim() ?? '';
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    return JSON.parse(text) as ParsedIntent;
  } catch (err) {
    console.error('Gemini parse error:', err);
    return { intent: 'unknown', customer_name: null };
  }
}
