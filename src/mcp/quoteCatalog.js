/**
 * Tie quote line items to Jobber Products & Services so drafts use the real
 * price book (ids, prices, taxable flags) instead of free-typed lines.
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Rates Brennan quotes at, when they differ from the Jobber catalog price. */
export const HOUSE_RATES = {
  '1 labor': 60,
};

function similar(products, name) {
  const words = norm(name).split(' ').filter((w) => w.length > 2);
  return products
    .map((p) => ({ p, hits: words.filter((w) => norm(p.name).includes(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => x.p.name);
}

/**
 * @returns {{ lineItems: object[], unmatched: object[], warnings: string[] }}
 */
export function matchLineItemsToCatalog(lineItems = [], products = []) {
  const byName = new Map(products.map((p) => [norm(p.name), p]));
  const warnings = [];
  const unmatched = [];

  const out = (Array.isArray(lineItems) ? lineItems : []).map((item, i) => {
    if (item.textOnly) return item;
    const product =
      (item.productOrServiceId && products.find((p) => p.id === item.productOrServiceId)) ||
      byName.get(norm(item.name));
    if (!product) {
      const suggestions = similar(products, item.name);
      unmatched.push({ index: i, name: item.name, suggestions });
      warnings.push(
        `Line ${i + 1} "${item.name}" is not in Jobber Products & Services` +
          (suggestions.length ? ` — did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?` : '')
      );
      return item;
    }

    const enriched = {
      ...item,
      name: product.name,
      productOrServiceId: product.id,
      category: item.category || product.category,
    };
    const houseRate = HOUSE_RATES[norm(product.name)];
    if (item.unitPrice == null && item.price == null) {
      enriched.unitPrice = houseRate != null ? houseRate : product.unitPrice;
    }
    if (typeof item.taxable !== 'boolean' && typeof product.taxable === 'boolean') {
      enriched.taxable = product.taxable;
    }
    const price = Number(enriched.unitPrice ?? enriched.price);
    // Lump-sum service lines (qty 1) are intentionally custom-priced.
    const isLumpSum = product.category !== 'PRODUCT' && Number(enriched.quantity ?? 1) === 1;
    const expected = houseRate != null ? houseRate : Number(product.unitPrice);
    if (!isLumpSum && Number.isFinite(price) && Math.abs(price - expected) > 0.005) {
      warnings.push(
        houseRate != null
          ? `Line ${i + 1} "${product.name}" priced ${price} vs house rate ${houseRate} (catalog ${product.unitPrice})`
          : `Line ${i + 1} "${product.name}" priced ${price} vs catalog ${product.unitPrice}`
      );
    }
    return enriched;
  });

  return { lineItems: out, unmatched, warnings };
}
