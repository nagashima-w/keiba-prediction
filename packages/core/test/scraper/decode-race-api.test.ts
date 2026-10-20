import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeRaceApiPayload,
  findEncodedPayload,
  RaceApiDecodeError,
} from "../../src/scraper/decode-race-api.js";

/** JSON を zlib で圧縮して base64 にする(netkeiba の race_api の `compress=1` の応答と同じ形)。 */
function encode(value: unknown): string {
  return deflateSync(Buffer.from(JSON.stringify(value), "utf-8")).toString("base64");
}

describe("decodeRaceApiPayload(base64 → zlib → JSON)", () => {
  it("日本語を含む JSON を、base64・zlib を戻して UTF-8 のまま復元する", () => {
    const value = [{ name: "秋華賞", kigou: ["N21", "(国際) 牝(指)", ""] }];
    expect(decodeRaceApiPayload(encode(value))).toEqual(value);
  });

  it("zlib として読めないデータは stage=inflate の RaceApiDecodeError", () => {
    const notZlib = Buffer.from("これはzlibではない", "utf-8").toString("base64");
    const error = (() => {
      try {
        decodeRaceApiPayload(notZlib);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(RaceApiDecodeError);
    expect((error as RaceApiDecodeError).stage).toBe("inflate");
  });

  it("zlib は読めるが JSON でないデータは stage=json の RaceApiDecodeError", () => {
    const notJson = deflateSync(Buffer.from("{壊れた", "utf-8")).toString("base64");
    const error = (() => {
      try {
        decodeRaceApiPayload(notJson);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(RaceApiDecodeError);
    expect((error as RaceApiDecodeError).stage).toBe("json");
  });
});

describe("findEncodedPayload(`_last_dt` で終わらないキーの値を取り出す)", () => {
  it("ハッシュ付きのキーでも、`_last_dt` のキーは選ばない", () => {
    const data = { "nkrace_gw::race_ids_abc_last_dt": "2026-10-20", "nkrace_gw::race_ids_abc": "PAYLOAD" };
    expect(findEncodedPayload(data)).toEqual({ ok: true, value: "PAYLOAD" });
  });

  it("対象のキーが無い(`_last_dt` だけ・空)ときは reason=no-key", () => {
    expect(findEncodedPayload({ "x_last_dt": "a" })).toEqual({ ok: false, reason: "no-key" });
    expect(findEncodedPayload({})).toEqual({ ok: false, reason: "no-key" });
  });

  it("値が文字列でないときは reason=not-string(呼び出し側が自分の文言で失敗にする)", () => {
    expect(findEncodedPayload({ "k": 123 })).toEqual({ ok: false, reason: "not-string" });
  });
});
