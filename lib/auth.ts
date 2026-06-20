import { supabase } from './supabase';
import type { SalesRep } from '../types';

export async function getAuthorizedRep(
  whatsappNumber: string
): Promise<SalesRep | null> {
  // WhatsApp sends numbers without +; DB stores them with +
  const normalized = whatsappNumber.startsWith('+') ? whatsappNumber : `+${whatsappNumber}`;
  const { data } = await supabase
    .from('sales_reps')
    .select('*')
    .eq('whatsapp_number', normalized)
    .eq('is_active', true)
    .single();

  return (data as SalesRep) ?? null;
}
