import { config } from './load-env';
config();

import { parseIntent } from '../lib/gemini';

const cases = [
  'Statement for Gulf Trading last month',
  'Get me Acme Corp balance for May 2026',
  'I need the account summary for Al Fardan this quarter',
  'statement',                         // no customer, no date
  'hello how are you',                 // unknown intent
  'Customer 1042 statement 01 Jan to 31 Mar 2026',
];

async function run() {
  console.log('Testing Gemini intent parser...\n');

  for (const msg of cases) {
    const result = await parseIntent(msg);
    console.log(`Input:  "${msg}"`);
    console.log(`Output: ${JSON.stringify(result)}`);
    console.log('');
  }

  console.log('Gemini test complete.');
}

run().catch(console.error);
