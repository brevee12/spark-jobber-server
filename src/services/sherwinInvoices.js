/**
 * Parse the text of a Sherwin-Williams invoice packet.
 * Quantity and can size are on these invoices. QuickBooks does not store them.
 * Gallons are qty × size for GALLON, 5 GAL, QUART, and PINT. A negative
 * price is a return. Brushes, pails, and tubes are not gallons.
 */

const PAINT_SIZES = [
  ['5 GAL', 5],
  ['GALLON', 1],
  ['QUART', 0.25],
  ['PINT', 0.125],
];

export function parseProductLine(line) {
  const match = String(line || '').match(
    /^(\d{3,4}-\d{3,5})\s+(.+?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)$/
  );
  if (!match) return null;
  const rest = match[2];
  const size = PAINT_SIZES.find(([label]) => rest.startsWith(`${label} `));
  const qty = Number(match[3]);
  const value = Number(match[5]);
  const sign = value < 0 ? -1 : 1;
  const body = size ? rest.slice(size[0].length).trim() : rest;
  const productMatch = body.match(/^(\S+)\s+(.+)$/);
  const gallons = size ? Math.round(sign * Math.abs(qty) * size[1] * 100) / 100 : null;
  return {
    salesNumber: match[1],
    size: size ? size[0] : null,
    product: productMatch?.[1] || null,
    description: productMatch?.[2] || body,
    qty: sign * Math.abs(qty),
    gallons,
    value,
  };
}

function invoiceGallons(lines) {
  const paint = lines.filter((line) => line.gallons != null);
  if (!paint.length) return lines.length ? 0 : null;
  return Math.round(paint.reduce((sum, line) => sum + line.gallons, 0) * 100) / 100;
}

export function parseSherwinInvoiceText(text) {
  const parts = String(text || '').split(/(?=ACCOUNT:)/);
  const byDoc = new Map();

  for (const part of parts) {
    const docNumber = part.match(/No\.\s+(\d{10,})/)?.[1];
    if (!docNumber) continue;
    const po = part.match(/PO#[ \t]*([A-Za-z0-9-]+)/)?.[1] || null;
    const jobNumber = po && /^\d{4,6}$/.test(po) ? po : null;
    const dateMatch = part.match(/DATE:[ \t]*(\d{2})\/(\d{2})\/(\d{4})/);
    const date = dateMatch ? `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}` : null;
    const amountMatch = part.match(/(?:CHARGE|CASH)[ \t]+\$([0-9,]+\.\d{2})/);
    const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;
    const lines = part
      .split('\n')
      .map((raw) => parseProductLine(raw.trim()))
      .filter(Boolean);

    const prev = byDoc.get(docNumber);
    if (!prev) {
      byDoc.set(docNumber, { docNumber, po, jobNumber, date, amount, lines });
      continue;
    }
    for (const line of lines) {
      const key = JSON.stringify(line);
      if (!prev.lines.some((existing) => JSON.stringify(existing) === key)) prev.lines.push(line);
    }
    if (prev.amount == null) prev.amount = amount;
    if (!prev.jobNumber && jobNumber) {
      prev.jobNumber = jobNumber;
      prev.po = po;
    }
  }

  return [...byDoc.values()].map((invoice) => ({
    ...invoice,
    gallons: invoiceGallons(invoice.lines),
  }));
}
