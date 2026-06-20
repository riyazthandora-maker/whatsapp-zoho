import type { VercelRequest, VercelResponse } from '@vercel/node';
import { syncCustomers } from '../lib/sync';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel sets CRON_SECRET and sends it as the Bearer token on cron invocations
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const synced = await syncCustomers();
  console.log(`Synced ${synced} customers from Zoho`);
  res.json({ synced });
}
