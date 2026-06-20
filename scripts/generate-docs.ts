import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const OUT = path.join('scripts', 'WhatsAppBot_UserGuide.pdf');
const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
doc.pipe(fs.createWriteStream(OUT));

const PW = 595;
const PH = 842;
const ML = 60;
const MR = 60;
const CW = PW - ML - MR;  // 475
const BLUE = '#1a56a0';
const DARK = '#1a1a1a';
const GREY = '#666666';
const LIGHT_BG = '#f0f4fa';
const LINE_COLOR = '#cccccc';
const RED = '#c0392b';

let y = 0;

// ── helpers ───────────────────────────────────────────────────────────────────

function needsPage(height: number) {
  if (y + height > PH - 40) {
    doc.addPage();
    y = 50;
  }
}

function drawSectionTitle(text: string) {
  needsPage(32);
  y += 10;
  doc.rect(ML, y, CW, 22).fill(BLUE);
  doc.fillColor('white').font('Helvetica-Bold').fontSize(10)
    .text(text, ML + 8, y + 6, { width: CW - 16, lineBreak: false });
  y += 30;
  doc.fillColor(DARK);
}

function drawPara(text: string) {
  doc.font('Helvetica').fontSize(9).fillColor(DARK);
  const h = doc.heightOfString(text, { width: CW - 16 });
  needsPage(h + 8);
  doc.text(text, ML + 8, y, { width: CW - 16 });
  y += h + 8;
}

function drawBullet(text: string) {
  doc.font('Helvetica').fontSize(9).fillColor(DARK);
  const h = doc.heightOfString(text, { width: CW - 30 });
  needsPage(h + 6);
  doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(11)
    .text('•', ML + 8, y, { width: 14, lineBreak: false });
  doc.fillColor(DARK).font('Helvetica').fontSize(9)
    .text(text, ML + 22, y, { width: CW - 30 });
  y += h + 6;
}

function drawTableRow(col1: string, col2: string, shade: boolean, bold1 = false, bold2 = false) {
  const rowH = 20;
  needsPage(rowH);
  if (shade) doc.rect(ML, y, CW, rowH).fill(LIGHT_BG);
  doc.fillColor(GREY).font(bold1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .text(col1, ML + 8, y + 5, { width: 170, lineBreak: false });
  doc.fillColor(DARK).font(bold2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .text(col2, ML + 185, y + 5, { width: CW - 193, lineBreak: false });
  y += rowH;
}

function drawCommandRow(cmd: string, desc: string, shade: boolean) {
  const rowH = 20;
  needsPage(rowH);
  if (shade) doc.rect(ML, y, CW, rowH).fill(LIGHT_BG);
  doc.fillColor(RED).font('Courier').fontSize(8.5)
    .text(cmd, ML + 8, y + 5, { width: 200, lineBreak: false });
  doc.fillColor(DARK).font('Helvetica').fontSize(8.5)
    .text(desc, ML + 215, y + 5, { width: CW - 223, lineBreak: false });
  y += rowH;
}

function drawCodeBox(lines: string[]) {
  const boxH = lines.length * 16 + 14;
  needsPage(boxH + 8);
  doc.rect(ML + 8, y, CW - 16, boxH).fill('#f7f7f7').stroke(LINE_COLOR);
  lines.forEach((line, i) => {
    doc.fillColor(RED).font('Courier').fontSize(8.5)
      .text(line, ML + 18, y + 8 + i * 16, { width: CW - 36, lineBreak: false });
  });
  y += boxH + 8;
  doc.fillColor(DARK);
}

function drawIssueRow(issue: string, fix: string, shade: boolean) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(RED);
  const h1 = doc.heightOfString(issue, { width: CW - 16 });
  doc.font('Helvetica').fontSize(8.5).fillColor(DARK);
  const h2 = doc.heightOfString(fix, { width: CW - 16 });
  const rowH = h1 + h2 + 14;
  needsPage(rowH);
  if (shade) doc.rect(ML, y, CW, rowH).fill(LIGHT_BG);
  doc.fillColor(RED).font('Helvetica-Bold').fontSize(8.5)
    .text(issue, ML + 8, y + 5, { width: CW - 16 });
  doc.fillColor(DARK).font('Helvetica').fontSize(8.5)
    .text(fix, ML + 8, y + 5 + h1 + 2, { width: CW - 16 });
  y += rowH;
}

function gap(n = 10) { y += n; }

// ── Cover ─────────────────────────────────────────────────────────────────────
doc.rect(0, 0, PW, 145).fill(BLUE);
doc.fillColor('white').font('Helvetica-Bold').fontSize(24)
  .text('WhatsApp Statement Bot', ML, 40, { width: CW, lineBreak: false });
doc.fillColor('#d0e4f7').font('Helvetica').fontSize(13)
  .text('User Guide & Configuration Reference', ML, 78, { width: CW, lineBreak: false });
doc.fillColor('#90b8e0').font('Helvetica').fontSize(9)
  .text('Fonzal Building Materials Trading LLC  ·  Powered by Zoho Books', ML, 112, { width: CW, lineBreak: false });
y = 165;
doc.fillColor(DARK);

// ── 1. Overview ───────────────────────────────────────────────────────────────
drawSectionTitle('1.  Overview');
drawPara(
  'The WhatsApp Statement Bot allows authorised sales representatives to instantly retrieve customer ' +
  'outstanding account statements from Zoho Books via WhatsApp. A rep sends a customer name, ' +
  'the bot finds the account, and responds with the current balance due and an official PDF statement ' +
  '— all within seconds, without logging into Zoho Books.'
);

// ── 2. Configured Numbers ─────────────────────────────────────────────────────
drawSectionTitle('2.  Configured Numbers');
drawTableRow('Bot WhatsApp Number', '+971543956068', false, true);
gap(8);
drawTableRow('Name', 'Role  |  WhatsApp Number', false, true, true);
doc.rect(ML, y, CW, 1).fill(LINE_COLOR); y += 1;
drawTableRow('Rizin',    'Admin  |  +971507606563', false);
drawTableRow('Rizin_r',  'Rep      |  +971508553451', true);
drawTableRow('Fermil_r', 'Rep      |  +971523614975', false);
gap(6);
doc.fillColor(GREY).font('Helvetica').fontSize(8)
  .text('Only numbers listed above can interact with the bot. All other numbers receive an access denied message.', ML + 8, y, { width: CW - 16 });
y += 18;

// ── 3. How to Use — Sales Rep ─────────────────────────────────────────────────
drawSectionTitle('3.  How to Use — Sales Rep');
drawBullet('Save the bot number +971543956068 in your WhatsApp contacts.');
drawBullet('Send a message with the customer name. Examples:');
drawCodeBox(['Statement for Gulf Trading', 'Balance for Upasna', 'Upasna General']);
drawBullet('If multiple customers match, the bot sends a numbered list — reply with the number to select.');
drawBullet('The bot replies with the Balance Due (as of today) and attaches an official PDF statement.');
drawBullet('If an error occurs, reply retry to try again.');

// ── 4. How to Use — Admin ─────────────────────────────────────────────────────
drawSectionTitle('4.  How to Use — Admin Commands  (Rizin · +971507606563 only)');
drawPara('In addition to querying statements, the admin number has access to the following management commands:');
gap(4);
drawCommandRow('list reps',                   'Show all registered reps and their status', false);
drawCommandRow('add rep <Name>, <+phone>',     'Register a new sales rep', true);
drawCommandRow('remove rep <+phone>',          'Deactivate a sales rep', false);
drawCommandRow('audit',                        'Show the last 10 statement requests (all reps)', true);
drawCommandRow('audit 20',                     'Show the last N requests (e.g. 20)', false);
drawCommandRow('sync',                         'Refresh the customer list from Zoho Books now', true);
drawCommandRow('help',                         'Show this command reference in WhatsApp', false);

// ── 5. Customer Search ────────────────────────────────────────────────────────
drawSectionTitle('5.  Customer Search');
drawBullet('Search is partial and case-insensitive — typing "gulf" matches "LEMINAR GULF TRADING CO."');
drawBullet('Fuzzy matching handles common spelling variations — "Upasana" finds "UPASNA GENERAL TRADING LLC".');
drawBullet('If more than 5 results match, the bot shows 5 at a time — type more to see the next page.');
drawBullet('The customer list syncs from Zoho Books nightly at 2:00 AM UTC. Use the sync command to refresh immediately after adding a new customer in Zoho.');

// ── 6. Statement PDF ──────────────────────────────────────────────────────────
drawSectionTitle('6.  Statement PDF');
drawBullet('Generated directly by Zoho Books on the official Fonzal letterhead.');
drawBullet('Date range: 01 January 2025 to today (automatically set).');
drawBullet('Filter: Outstanding invoices only — fully paid invoices are excluded.');
drawBullet('Includes Account Summary (Balance Due), full transaction list, and Aging Summary.');

// ── 7. System Details ─────────────────────────────────────────────────────────
drawSectionTitle('7.  System Details');
drawTableRow('Bot URL',            'https://whatsapp-zoho.vercel.app', false);
drawTableRow('Hosting',            'Vercel — serverless, always on', true);
drawTableRow('Accounting System',  'Zoho Books', false);
drawTableRow('Customer Sync',      'Automatic — nightly at 02:00 UTC', true);
drawTableRow('Session Timeout',    '15 minutes — conversation resets after inactivity', false);
drawTableRow('Audit Log',          'Every request is logged with rep name, customer, and timestamp', true);

// ── 8. Troubleshooting ────────────────────────────────────────────────────────
drawSectionTitle('8.  Troubleshooting');
drawIssueRow('Bot not responding', 'Ensure your WhatsApp number is registered. Ask your admin to check the rep list.', false);
drawIssueRow('Customer not found', 'Try a shorter or partial name. If the customer was recently added to Zoho, ask the admin to run sync.', true);
drawIssueRow('"Sorry, could not retrieve the statement"', 'Reply retry to try again. If the problem persists, contact the system administrator.', false);
drawIssueRow('No PDF attached', 'The customer may have no outstanding invoices in Zoho Books. The text message will confirm the balance.', true);

// ── Footer ────────────────────────────────────────────────────────────────────
gap(20);
doc.rect(ML, y, CW, 1).fill(LINE_COLOR); y += 8;
const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
  .text(
    `Fonzal Building Materials Trading LLC  ·  WhatsApp Statement Bot  ·  Document generated ${today}`,
    ML, y, { width: CW, align: 'center', lineBreak: false }
  );

doc.end();
console.log(`PDF saved to: ${OUT}`);
