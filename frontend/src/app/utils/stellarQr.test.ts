import { parseStellarQrPayload, maskValue } from "./stellarQr";

const ADDR = "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTLFL2F7HVRQG5LDHNWY2QTWA";

describe("parseStellarQrPayload", () => {
  it("accepts a raw G-address", () => {
    expect(parseStellarQrPayload(` ${ADDR} `)).toBe(ADDR);
  });
  it("extracts the destination from a SEP-7 pay URI", () => {
    expect(parseStellarQrPayload(`web+stellar:pay?destination=${ADDR}&amount=10`)).toBe(ADDR);
  });
  it("rejects invalid payloads", () => {
    expect(parseStellarQrPayload("hello")).toBeNull();
    expect(parseStellarQrPayload("web+stellar:pay?destination=GBAD")).toBeNull();
    expect(parseStellarQrPayload("web+stellar:pay")).toBeNull();
  });
  it("masks values", () => {
    expect(maskValue(ADDR)).toBe("GBUQ••••QTWA");
  });
});
