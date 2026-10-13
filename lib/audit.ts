import { supabase } from './supabase';

export async function logStatement(params: {
  repId: string | null;
  repName: string | null;
  repPhone: string | null;
  customerZohoId: string;
  customerName: string;
  deliveryStatus: 'delivered' | 'failed';
}): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await supabase.from('audit_log').insert({
    rep_id: params.repId,
    rep_name: params.repName,
    rep_phone: params.repPhone,
    customer_zoho_id: params.customerZohoId,
    customer_name: params.customerName,
    statement_from: today,
    statement_to: today,
    delivery_status: params.deliveryStatus,
  });
}
