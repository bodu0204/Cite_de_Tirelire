import { describe, expect, it } from "vitest";
import { digits, signedDigits } from "../numeric";

describe("digits", () => {
  it("半角の数字はそのまま", () => expect(digits("12345")).toBe("12345"));
  it("全角の数字を半角にする", () => expect(digits("１２３４５")).toBe("12345"));
  it("全角と半角が混ざっても受け付ける", () => expect(digits("1２3４")).toBe("1234"));
  it("区切りや単位を落とす", () => expect(digits("１，０００円")).toBe("1000"));
  it("マイナスは落とす", () => expect(digits("－５")).toBe("5"));
});

describe("signedDigits", () => {
  it("先頭の半角マイナスを残す", () => expect(signedDigits("-120")).toBe("-120"));
  it("全角マイナスや長音記号をマイナスとみなす", () => {
    expect(signedDigits("－１２０")).toBe("-120");
    expect(signedDigits("ー１２０")).toBe("-120");
    expect(signedDigits("−120")).toBe("-120");
  });
  it("途中のマイナスは落とす", () => expect(signedDigits("1-2-3")).toBe("123"));
  it("マイナスだけの入力中も残す", () => expect(signedDigits("ー")).toBe("-"));
});
