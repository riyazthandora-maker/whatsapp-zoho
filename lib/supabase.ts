import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export const supabase = new Proxy(Object.create(null) as SupabaseClient, {
  get(_target, prop: string | symbol) {
    if (!_client) {
      _client = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );
    }
    const val = (_client as any)[prop as string];
    return typeof val === 'function' ? val.bind(_client) : val;
  },
});
