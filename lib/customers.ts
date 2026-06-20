import { supabase } from './supabase';
import type { CustomerMatch } from '../types';

const PAGE_SIZE = 5;

export async function findCustomers(
  query: string,
  offset = 0
): Promise<{ matches: CustomerMatch[]; hasMore: boolean }> {
  // Uses pg_trgm word_similarity for fuzzy matching (handles typos/spelling variations)
  const { data } = await supabase.rpc('search_customers', {
    q: query,
    lim: PAGE_SIZE + 1,
    off: offset,
  });

  const all = (data ?? []) as CustomerMatch[];
  const hasMore = all.length > PAGE_SIZE;
  return { matches: all.slice(0, PAGE_SIZE), hasMore };
}
