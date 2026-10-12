/** Writes text to the clipboard. Resolves false when the browser refuses (no secure context, denied). */
export async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Saves a Blob as a file through a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Filename from a Content-Disposition header, restricted to safe characters. */
export function attachmentFilename(header: string | null, fallback: string): string {
  const match = header ? /filename="?([^";]+)"?/i.exec(header) : null;
  const name = match?.[1]?.trim();
  return name && /^[\w.-]{1,128}$/.test(name) ? name : fallback;
}

/** Explorer link for a txid, only for https templates carrying the {txid} placeholder. */
export function explorerTxUrl(template: string | null | undefined, txid: string): string | null {
  if (!template || !template.startsWith("https://") || !template.includes("{txid}")) return null;
  return template.replace("{txid}", encodeURIComponent(txid));
}
