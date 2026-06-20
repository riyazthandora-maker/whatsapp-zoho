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
}

