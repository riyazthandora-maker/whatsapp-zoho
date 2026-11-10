import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runDunningJob } from '../lib/dunning-runner';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await runDunningJob();
  console.log(`[send-dunning] done in ${result.elapsed_ms}ms sent=${result.sent} advanced=${result.advanced} finalized=${result.finalized} errors=${result.errors.length}`);
  if (result.errors.length) console.error('[send-dunning] errors:', result.errors);

  res.json(result);
}
