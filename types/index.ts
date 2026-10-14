export type SessionState =
  | 'idle'
  | 'awaiting_customer'
  | 'awaiting_customer_selection'
  | 'awaiting_retry';

export interface Session {
  state: SessionState;
  repId: string;
  repName: string;
  resolvedCustomerId?: string;
  resolvedCustomerName?: string;
  customerCandidates?: CustomerMatch[];
  customerQuery?: string;
  customerOffset?: number;
}

export interface SalesRep {
  id: string;
  name: string;
  whatsapp_number: string;
  is_active: boolean;
  role: 'rep' | 'admin';
}

export interface ZohoCustomer {
  zoho_contact_id: string;
  name: string;
  email?: string;
  phone?: string;
}

export interface CustomerMatch {
  zoho_contact_id: string;
  name: string;
}

export interface ParsedIntent {
  intent: 'get_statement' | 'unknown';
  customer_name: string | null;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  button?: { text: string; payload: string };
}

// ── Dunning system types ───────────────────────────────────────────────────────

export interface DunningSessionData {
  commitmentId: string;
  exchangeCount: number;
  unclearStreak?: number;
}

export interface DunningReply {
  reply: string;
  status: 'ongoing' | 'committed' | 'soft_commitment' | 'escalate' | 'closed' | 'unclear';
  committedDatePhrase: string | null;
  committedDate: string | null;
  reason: string | null;
  languageDetected: string;
  refused: boolean;
}

export interface CommitmentRecord {
  id: string;
  customer_zoho_id: string;
  customer_name: string;
  customer_phone: string;
  invoice_number: string;
  amount: number;
  committed_date: string | null;
  assigned_rep_id: string | null;
  status: string;
  no_count: number;
  exchange_count: number;
  template_step: number;
  template_sent_at: string | null;
  customer_replied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepTask {
  id: string;
  rep_id: string | null;
  customer_zoho_id: string;
  customer_name: string;
  invoice_number: string;
  amount: number;
  task_type: 'collection' | 'escalation' | 'follow_up';
  due_date: string | null;
  status: 'open' | 'done' | 'broken' | 'noted';
  note: string | null;
  created_at: string;
  updated_at: string;
}
