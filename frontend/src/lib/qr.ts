import QRCode from "qrcode";

const QUIET_ZONE = 4;

/** One SVG path of all dark modules (with the standard 4-module quiet zone), or null when unencodable. */
export function qrModulesPath(text: string): { size: number; d: string } | null {
  let code: ReturnType<typeof QRCode.create>;
  try {
    code = QRCode.create(text, { errorCorrectionLevel: "M" });
  } catch {
    try {
      code = QRCode.create(text, { errorCorrectionLevel: "L" });
    } catch {
      return null;
    }
  }
  const { size } = code.modules;
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (code.modules.get(row, col))
        parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
    }
  }
  return { size: size + QUIET_ZONE * 2, d: parts.join("") };
}
