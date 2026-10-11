const BASE = () => process.env.ZOHO_BASE_URL || 'https://www.zohoapis.com';
const ACCOUNTS = () => process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ORG = () => process.env.ZOHO_ORGANIZATION_ID!;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID!,
    client_secret: process.env.ZOHO_CLIENT_SECRET!,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN!,
  });

  const res = await fetch(`${ACCOUNTS()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = (await res.json()) as { access_token: string; expires_in: number };
  if (!data.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function zohoHeaders(token: string, accept = 'application/json') {
  return { Authorization: `Zoho-oauthtoken ${token}`, Accept: accept };
}

export interface ContactSummary {
  balanceDue: number;
  currencySymbol: string;
  currencyCode: string;
}

export async function getContactSummary(contactId: string): Promise<ContactSummary> {
  const token = await getAccessToken();
  const qs = new URLSearchParams({ organization_id: ORG() });

  const res = await fetch(`${BASE()}/books/v3/contacts/${contactId}?${qs}`, {
    headers: zohoHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zoho contacts API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  const c = data.contact ?? {};

  return {
    balanceDue: c.outstanding_receivable_amount ?? 0,
    currencySymbol: c.currency_symbol ?? 'AED ',
    currencyCode: c.currency_code ?? 'AED',
  };
}

export interface OutstandingInvoice {
  invoice_number: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  currency_symbol: string;
}

export async function getOutstandingInvoices(contactId: string): Promise<OutstandingInvoice[]> {
  const token = await getAccessToken();

  const fetchByStatus = async (status: string) => {
    const qs = new URLSearchParams({
      organization_id: ORG(),
      contact_id: contactId,
      status,
      per_page: '200',
    });
    const res = await fetch(`${BASE()}/books/v3/invoices?${qs}`, { headers: zohoHeaders(token) });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.invoices ?? []) as any[];
  };

  const [sent, overdue, partial] = await Promise.all([
    fetchByStatus('sent'),
    fetchByStatus('overdue'),
    fetchByStatus('partially_paid'),
  ]);

  const seen = new Set<string>();
  const invoices: OutstandingInvoice[] = [];

  for (const inv of [...overdue, ...sent, ...partial]) {
    if (seen.has(inv.invoice_id)) continue;
    seen.add(inv.invoice_id);
    if ((inv.balance ?? 0) <= 0) continue;
    invoices.push({
      invoice_number: inv.invoice_number,
      date: inv.date,
      due_date: inv.due_date,
      total: inv.total ?? 0,
      balance: inv.balance ?? 0,
      currency_symbol: inv.currency_symbol ?? '',
    });
  }

  return invoices.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getStatementPdf(contactId: string): Promise<Buffer | null> {
  const token = await getAccessToken();
  const today = new Date().toISOString().split('T')[0];
  const qs = new URLSearchParams({
    organization_id: ORG(),
    start_date: '2025-01-01',
    end_date: today,
    filter_by: 'Status.Outstanding',
  });

  const res = await fetch(
    `${BASE()}/books/v3/contacts/${contactId}/statements?${qs}`,
    { headers: zohoHeaders(token, 'application/pdf') }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[zoho] statement PDF ${res.status}: ${body}`);
    return null;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('pdf')) {
    console.error(`[zoho] statement unexpected content-type: ${contentType}`);
    return null;
  }

  return Buffer.from(await res.arrayBuffer());
}

function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aMap) {
    intersection += Math.min(count, bMap.get(bg) ?? 0);
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

function itemMatchesQuery(itemName: string, query: string): boolean {
  const name = itemName.toLowerCase();
  const q = query.toLowerCase();
  if (name.includes(q)) return true;
  return name.split(/\s+/).some(word => diceSimilarity(word, q) >= 0.5);
}

export interface ZohoItem {
  item_id: string;
  name: string;
  sku: string;
  stock_on_hand: number | null;
}

export async function searchItems(query: string): Promise<ZohoItem[]> {
  const token = await getAccessToken();
  const qs = new URLSearchParams({
    organization_id: ORG(),
    search_text: query,
    per_page: '200',
  });

  const res = await fetch(`${BASE()}/books/v3/items?${qs}`, {
    headers: zohoHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zoho items API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  const raw: any[] = data.items ?? [];

  return raw
    .filter(item => itemMatchesQuery(item.name ?? '', query))
    .map(item => ({
      item_id: item.item_id,
      name: item.name,
      sku: item.sku ?? '',
      stock_on_hand: item.stock_on_hand ?? null,
    }))
    .slice(0, 10);
}

export interface OverdueInvoice {
  invoice_id: string;
  invoice_number: string;
  contact_id: string;
  customer_name: string;
  due_date: string;
  balance: number;
  currency_symbol: string;
}

export async function getOverdueInvoices(): Promise<OverdueInvoice[]> {
  const token = await getAccessToken();
  const qs = new URLSearchParams({
    organization_id: ORG(),
    status: 'overdue',
    per_page: '200',
  });

  const res = await fetch(`${BASE()}/books/v3/invoices?${qs}`, {
    headers: zohoHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zoho overdue invoices ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  return ((data.invoices ?? []) as any[])
    .filter(inv => (inv.balance ?? 0) > 0)
    .map(inv => ({
      invoice_id: inv.invoice_id,
      invoice_number: inv.invoice_number,
      contact_id: inv.contact_id ?? inv.customer_id,
      customer_name: inv.customer_name,
      due_date: inv.due_date,
      balance: inv.balance ?? 0,
      currency_symbol: inv.currency_symbol ?? 'AED ',
    }));
}

export async function getUpcomingDueInvoices(daysFromNow: number): Promise<OverdueInvoice[]> {
  const token = await getAccessToken();
  const target = new Date();
  target.setDate(target.getDate() + daysFromNow);
  const dateStr = target.toISOString().split('T')[0];

  const qs = new URLSearchParams({
    organization_id: ORG(),
    status: 'sent',
    due_date_start: dateStr,
    due_date_end: dateStr,
    per_page: '200',
  });

  const res = await fetch(`${BASE()}/books/v3/invoices?${qs}`, {
    headers: zohoHeaders(token),
  });

  if (!res.ok) return [];

  const data = (await res.json()) as any;
  return ((data.invoices ?? []) as any[])
    .filter(inv => (inv.balance ?? 0) > 0)
    .map(inv => ({
      invoice_id: inv.invoice_id,
      invoice_number: inv.invoice_number,
      contact_id: inv.contact_id ?? inv.customer_id,
      customer_name: inv.customer_name,
      due_date: inv.due_date,
      balance: inv.balance ?? 0,
      currency_symbol: inv.currency_symbol ?? 'AED ',
    }));
}

export async function listContacts(page = 1): Promise<
  { contact_id: string; contact_name: string; email: string; phone: string }[]
> {
  const token = await getAccessToken();
  const qs = new URLSearchParams({
    organization_id: ORG(),
    contact_type: 'customer',
    status: 'active',
    page: String(page),
    per_page: '200',
  });

  const res = await fetch(`${BASE()}/books/v3/contacts?${qs}`, {
    headers: zohoHeaders(token),
  });

  const data = (await res.json()) as any;
  return data.contacts ?? [];
}
