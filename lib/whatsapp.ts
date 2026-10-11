import crypto from 'crypto';

const GRAPH_API = 'https://graph.facebook.com/v25.0';
const PHONE_ID = () => process.env.WHATSAPP_PHONE_NUMBER_ID!;
const TOKEN = () => process.env.WHATSAPP_TOKEN!;

function authHeaders() {
  return {
    Authorization: `Bearer ${TOKEN()}`,
    'Content-Type': 'application/json',
  };
}

export function verifySignature(rawBody: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET!)
    .update(rawBody)
    .digest('hex');
  return `sha256=${expected}` === signature;
}

export async function sendText(to: string, body: string): Promise<void> {
  const res = await fetch(`${GRAPH_API}/${PHONE_ID()}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[whatsapp] sendText failed ${res.status}: ${detail}`);
  }
}

export async function sendDocument(
  to: string,
  mediaId: string,
  filename: string,
  caption: string
): Promise<void> {
  await fetch(`${GRAPH_API}/${PHONE_ID()}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, filename, caption },
    }),
  });
}

export async function uploadMedia(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  form.append('type', 'application/pdf');

  const res = await fetch(`${GRAPH_API}/${PHONE_ID()}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}` },
    body: form,
  });

  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  parameters: string[]
): Promise<void> {
  const res = await fetch(`${GRAPH_API}/${PHONE_ID()}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: parameters.length
          ? [{ type: 'body', parameters: parameters.map(p => ({ type: 'text', text: p })) }]
          : [],
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[whatsapp] sendTemplate failed ${res.status}: ${detail}`);
  }
}

export async function markAsRead(messageId: string): Promise<void> {
  const res = await fetch(`${GRAPH_API}/${PHONE_ID()}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[whatsapp] markAsRead failed ${res.status}: ${detail}`);
  }
}
