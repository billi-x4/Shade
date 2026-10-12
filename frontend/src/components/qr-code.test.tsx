import QRCode from "qrcode";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QrCode } from "@/components/qr-code";
import { qrModulesPath } from "@/lib/qr";

const URI =
  "zcash:utest18z20cdj59zmjdl23hyxzrgn0hr7tlexmmkwav5nwzpgd27yk4y0dc7mwwn3c0cp960swz78h7fqsvxg72jvv4mehvvattdaemqljkrk4?amount=0.01&memo=T3JkZXIgMTA0MiAoc2hhZGU6N0syUTlNWEEp";

describe("QR rendering", () => {
  it("draws one square per dark module inside a 4-module quiet zone", () => {
    const qr = qrModulesPath(URI);
    const code = QRCode.create(URI, { errorCorrectionLevel: "M" });
    const size = code.modules.size;
    expect(qr?.size).toBe(size + 8);
    const dark = Array.from(code.modules.data).filter(Boolean).length;
    expect(qr?.d.match(/M/g)?.length).toBe(dark);
    // Top-left finder pattern starts at the quiet-zone offset.
    expect(qr?.d.startsWith("M4 4h1v1h-1z")).toBe(true);
  });

  it("renders an accessible SVG element, not injected markup", () => {
    const { container } = render(<QrCode value={URI} label="QR code to pay 0.01 ZEC" />);
    const image = screen.getByRole("img", { name: "QR code to pay 0.01 ZEC" });
    expect(image.tagName.toLowerCase()).toBe("svg");
    expect(image.querySelectorAll("path")).toHaveLength(1);
    expect(container.innerHTML).not.toContain("<script");
  });

  it("falls back to a lower error-correction level for very long URIs and gives up beyond capacity", () => {
    expect(qrModulesPath(`zcash:${"a".repeat(2_500)}`)).not.toBeNull();
    expect(qrModulesPath("a".repeat(8_000))).toBeNull();
  });
});
