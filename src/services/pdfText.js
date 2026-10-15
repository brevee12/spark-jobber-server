/**
 * Pull text out of a Sherwin invoice PDF. Resend stores the file;
 * Jobber needs the PO, gallons, and amount that are only in the PDF.
 */

export async function extractPdfText(bytes) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pdf = await getDocumentProxy(data);
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : String(text || '');
  } finally {
    await pdf.destroy?.();
  }
}
