import PDFDocument from 'pdfkit';
import type { OutstandingInvoice } from './zoho';

const COMPANY = 'FONZAL BUILDING MATERIALS TRADING LLC';
const COMPANY_SUB = 'Office No. 35-105, Bi Dasmal Building 1\nAl Quoz Industrial Area 1, Dubai, UAE\nTRN 105279172800003';

function fmt(n: number, sym: string) {
  return `${sym}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day)} ${months[parseInt(m) - 1]} ${y}`;
}

export function generateStatementPdf(
  customerName: string,
  invoices: OutstandingInvoice[],
  asOf: string
): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const sym = invoices[0]?.currency_symbol ?? 'AED ';
    const total = invoices.reduce((s, i) => s + i.balance, 0);
    const W = 495; // usable width

    // ── Header ────────────────────────────────────────────────────────────────
    doc.fontSize(14).font('Helvetica-Bold').text(COMPANY, { align: 'right' });
    doc.fontSize(8).font('Helvetica').text(COMPANY_SUB, { align: 'right' });
    doc.moveDown(1.5);

    doc.fontSize(18).font('Helvetica-Bold').text('STATEMENT OF ACCOUNTS', { align: 'center' });
    doc.fontSize(9).font('Helvetica').text(`Outstanding as of ${asOf}`, { align: 'center' });
    doc.moveDown(1);

    // ── Customer block ────────────────────────────────────────────────────────
    doc.fontSize(9).font('Helvetica-Bold').text('To');
    doc.font('Helvetica').text(customerName);
    doc.moveDown(1);

    // ── Summary box ───────────────────────────────────────────────────────────
    const bx = 50, by = doc.y, bw = 200, bh = 60;
    doc.rect(bx, by, bw, bh).stroke();
    doc.fontSize(9).font('Helvetica-Bold').text('Account Summary', bx + 8, by + 6, { width: bw - 16 });
    doc.font('Helvetica').fontSize(8);
    doc.text('Total Outstanding:', bx + 8, by + 22, { continued: true, width: 110 });
    doc.font('Helvetica-Bold').text(fmt(total, sym), { align: 'right', width: bw - 16 });
    doc.font('Helvetica').text(`Invoices: ${invoices.length}`, bx + 8, by + 36);
    doc.y = by + bh + 16;

    // ── Table header ──────────────────────────────────────────────────────────
    const cols = { no: 50, date: 150, due: 240, amount: 330, balance: 420 };
    const rowH = 18;

    doc.rect(50, doc.y, W, rowH).fill('#333333');
    const hY = doc.y + 4;
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
    doc.text('Invoice #',    cols.no,     hY, { width: 90 });
    doc.text('Date',         cols.date,   hY, { width: 80 });
    doc.text('Due Date',     cols.due,    hY, { width: 80 });
    doc.text('Amount',       cols.amount, hY, { width: 80, align: 'right' });
    doc.text('Balance Due',  cols.balance,hY, { width: 80, align: 'right' });
    doc.y += rowH;

    // ── Table rows ────────────────────────────────────────────────────────────
    doc.fillColor('black').font('Helvetica').fontSize(8);
    invoices.forEach((inv, i) => {
      const y = doc.y;
      if (i % 2 === 0) doc.rect(50, y, W, rowH).fill('#f5f5f5');
      doc.fillColor('black');
      doc.text(inv.invoice_number,     cols.no,      y + 4, { width: 90 });
      doc.text(fmtDate(inv.date),      cols.date,    y + 4, { width: 80 });
      doc.text(fmtDate(inv.due_date),  cols.due,     y + 4, { width: 80 });
      doc.text(fmt(inv.total, sym),    cols.amount,  y + 4, { width: 80, align: 'right' });
      doc.text(fmt(inv.balance, sym),  cols.balance, y + 4, { width: 80, align: 'right' });
      doc.y += rowH;
    });

    // ── Total row ─────────────────────────────────────────────────────────────
    const tY = doc.y;
    doc.rect(50, tY, W, rowH).fill('#333333');
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
    doc.text('Total Balance Due', cols.no, tY + 4, { width: 355 });
    doc.text(fmt(total, sym), cols.balance, tY + 4, { width: 80, align: 'right' });
    doc.y += rowH + 20;

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.fillColor('#666666').fontSize(7).font('Helvetica')
      .text('This statement shows only invoices with an outstanding balance.', { align: 'center' });

    doc.end();
  });
}
