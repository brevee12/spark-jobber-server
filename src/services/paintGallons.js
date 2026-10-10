/**
 * Sherwin bills in QuickBooks list the product, not how many gallons were bought.
 * A one-gallon price is trusted only when another line for that same product
 * number is an exact multiple of it (2 cans, 3 cans, …). A 5-gallon price is
 * not 5× the gallon price, so those lines stay uncounted instead of guessed.
 * Empty pails, lids, and other sundries are not paint.
 */

const SUNDRY =
  /pail|lid\b|pole|putty|strainer|roller|brush|\btape\b|sandpaper|\btray\b|liner|\brags?\b|glove|blade|knife|caulk|\btube\b|\bcover\b|sanding|bucket|\btip\b|guard/i;

const MIN_GALLON_CENTS = 2500;
const MAX_CANS = 12;

export function formatGallons(gallons) {
  const n = Number(gallons);
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function productNumber(description) {
  const match = String(description || '').match(/Product Number:\s*([A-Za-z0-9/-]+)/i);
  return match?.[1] || null;
}

export function isCoatingLine(description) {
  const text = String(description || '');
  if (!text.trim() || /sales tax/i.test(text)) return false;
  if (SUNDRY.test(text)) return false;
  const sku = productNumber(text);
  if (sku) return /^[A-Za-z]/.test(sku);
  return /paint|primer|latex|enamel|stain|emerald|duration|cashmere|promar|superpaint/i.test(text);
}

/**
 * Gallons written on the line itself, such as "5 gal" or "LACQUER THINNER GAL".
 * A number glued to GL (product name "20GL") is a code, not a quantity.
 * Sundries stay null.
 */
export function explicitGallons(description) {
  const text = String(description || '');
  if (!text.trim() || /sales tax/i.test(text) || SUNDRY.test(text)) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s+(?:gallons?|gal|gl)\b/i);
  if (!match) {
    if (/\bgal(?:lon)?s?\b/i.test(text)) return 1;
    return null;
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}

function provenUnitPrices(amounts) {
  const cents = amounts.map((amount) => Math.round(Number(amount) * 100));
  const proven = new Set();
  for (const unit of cents) {
    if (unit < MIN_GALLON_CENTS) continue;
    const explainsAnother = cents.some(
      (amount) => amount > unit && amount % unit === 0 && amount / unit <= MAX_CANS
    );
    if (explainsAnother) proven.add(unit);
  }
  return proven;
}

function quantityFor(amount, proven) {
  const cents = Math.round(Number(amount) * 100);
  const units = [...proven].filter(
    (unit) => cents >= unit && cents % unit === 0 && cents / unit <= MAX_CANS
  );
  if (!units.length) return null;
  const unit = Math.min(...units);
  return cents / unit;
}

/**
 * Annotate each bill with gallons (known total) and unknownLines (coating
 * lines that could not be counted). gallons is null when nothing was counted.
 */
export function assignGallons(bills = []) {
  const rows = [];
  bills.forEach((bill, billIndex) => {
    (bill.lines || []).forEach((line) => {
      const description = line.description || '';
      if (/sales tax/i.test(description)) return;
      const explicit = explicitGallons(description);
      const coating = isCoatingLine(description);
      const sku = productNumber(description);
      rows.push({
        billIndex,
        description,
        amount: Number(line.amount),
        explicit,
        coating,
        sku,
        gallons: explicit,
      });
    });
  });

  const groups = new Map();
  for (const row of rows) {
    if (row.explicit != null || !row.coating || !row.sku) continue;
    if (!groups.has(row.sku)) groups.set(row.sku, []);
    groups.get(row.sku).push(row);
  }
  for (const lines of groups.values()) {
    const proven = provenUnitPrices(lines.map((line) => line.amount));
    for (const line of lines) line.gallons = quantityFor(line.amount, proven);
  }

  return bills.map((bill, billIndex) => {
    const lines = rows.filter((row) => row.billIndex === billIndex);
    const known = lines.filter((line) => line.gallons != null);
    const unknownLines = lines.filter((line) => line.coating && line.gallons == null).length;
    const gallons = known.length
      ? known.reduce((sum, line) => sum + line.gallons, 0)
      : null;
    return { gallons, unknownLines };
  });
}

export function paintGallonsNote({ gallons, unknown }) {
  const missing = Number(unknown) || 0;
  const known = gallons == null ? null : Number(gallons);
  const head =
    known == null
      ? 'Paint gallons bought: not on the QuickBooks invoices'
      : `Paint gallons bought: ${formatGallons(known)}`;
  if (!missing) return head;
  if (missing === 1) {
    return `${head}\n1 invoice has a line with no quantity, so that line is not in this total.`;
  }
  return `${head}\n${missing} invoices have a line with no quantity, so those lines are not in this total.`;
}
