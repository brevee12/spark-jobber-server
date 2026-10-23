/**
 * Pull text out of a Sherwin invoice PDF. Resend stores the file;
 * Jobber needs the PO, gallons, and amount that are only in the PDF.
 */

/**
 * unpdf rejects Node's Buffer even though Buffer is a Uint8Array.
 * Copy into a plain Uint8Array before opening the PDF.
 */
export function pdfBytes(bytes) {
  if (bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)) return bytes;
  return new Uint8Array(bytes);
}

export async function extractPdfText(bytes) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(pdfBytes(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : String(text || '');
  } finally {
    await pdf.destroy?.();
  }
}
