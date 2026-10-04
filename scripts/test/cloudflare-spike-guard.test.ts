import { describe, expect, it } from "vitest";
import {
  MAX_NETKEIBA_REQUESTS,
  MIN_INTERVAL_MS,
  RequestGuard,
} from "../cloudflare-spike/request-guard.js";
import { isAuthorized } from "../cloudflare-spike/auth.js";

/**
 * #159(#21-A)Cloudflare 移行スパイクの「netkeiba へ出すリクエストの守り」と「共有秘密の照合」。
 * いずれも実ネットワークには出ない純ロジック。
 */

describe("RequestGuard の固定値", () => {
  it("1回の実行の上限は10本、リクエスト間隔は2000ms(Issue #159 の合意値)", () => {
    expect(MAX_NETKEIBA_REQUESTS).toBe(10);
    expect(MIN_INTERVAL_MS).toBe(2000);
  });
});

describe("RequestGuard: 間隔の制御", () => {
  it("まだ1本も送っていなければ待たずに送れる", () => {
    const guard = new RequestGuard();
    expect(guard.next(5000)).toEqual({ allow: true, waitMs: 0 });
  });

  it.each([
    { now: 1000, expectedWait: 2000 },
    { now: 1500, expectedWait: 1500 },
    { now: 2999, expectedWait: 1 },
    { now: 3000, expectedWait: 0 },
    { now: 9000, expectedWait: 0 },
  ])("1000ms に送った直後、now=$now なら $expectedWait ms 待たせる", ({ now, expectedWait }) => {
    const guard = new RequestGuard();
    guard.markSent(1000);
    expect(guard.next(now)).toEqual({ allow: true, waitMs: expectedWait });
  });
});

describe("RequestGuard: 本数の上限", () => {
  it("9本送った時点ではまだ送れ、10本送ると max-requests で止まる", () => {
    const guard = new RequestGuard();
    for (let i = 0; i < 9; i += 1) {
      guard.markSent(i * 2000);
      guard.recordStatus(200);
    }
    expect(guard.sentCount).toBe(9);
    expect(guard.next(100000).allow).toBe(true);

    guard.markSent(18000);
    guard.recordStatus(200);
    expect(guard.sentCount).toBe(10);
    expect(guard.next(100000)).toEqual({ allow: false, reason: "max-requests" });
  });

  it("上限は注入でき、1本で止める設定も効く", () => {
    const guard = new RequestGuard({ maxRequests: 1 });
    guard.markSent(0);
    expect(guard.sentCount).toBe(1);
    expect(guard.next(10000)).toEqual({ allow: false, reason: "max-requests" });
  });
});

describe("RequestGuard: 400/403/429 の連続打ち切り", () => {
  it.each([400, 403, 429])("%i が2回連続したら consecutive-blocks で止まる", (status) => {
    const guard = new RequestGuard();
    guard.markSent(0);
    guard.recordStatus(status);
    expect(guard.next(10000).allow).toBe(true); // 1回では止まらない
    guard.markSent(10000);
    guard.recordStatus(status);
    expect(guard.next(20000)).toEqual({ allow: false, reason: "consecutive-blocks" });
  });

  it("種類が違っても(403 → 429)連続した拒否として数える", () => {
    const guard = new RequestGuard();
    guard.markSent(0);
    guard.recordStatus(403);
    guard.markSent(2000);
    guard.recordStatus(429);
    expect(guard.next(9000)).toEqual({ allow: false, reason: "consecutive-blocks" });
  });

  it("間に成功(200)が挟まれば連続は数え直しになる(403,200,403 では止まらない)", () => {
    const guard = new RequestGuard();
    guard.markSent(0);
    guard.recordStatus(403);
    guard.markSent(2000);
    guard.recordStatus(200);
    guard.markSent(4000);
    guard.recordStatus(403);
    expect(guard.sentCount).toBe(3);
    expect(guard.next(9000).allow).toBe(true);
  });

  it.each([404, 500, 503, 301])("%i は拒否として数えない(2回続いても止まらない)", (status) => {
    const guard = new RequestGuard();
    guard.markSent(0);
    guard.recordStatus(status);
    guard.markSent(2000);
    guard.recordStatus(status);
    expect(guard.sentCount).toBe(2);
    expect(guard.next(9000).allow).toBe(true);
  });

  it("ネットワークエラー(status=null)は連続を途切れさせない(403,null,403 で止まる)が、拒否にも数えない(null,null では止まらない)", () => {
    const interleaved = new RequestGuard();
    interleaved.markSent(0);
    interleaved.recordStatus(403);
    interleaved.markSent(2000);
    interleaved.recordStatus(null);
    interleaved.markSent(4000);
    interleaved.recordStatus(403);
    expect(interleaved.next(9000)).toEqual({ allow: false, reason: "consecutive-blocks" });

    const onlyErrors = new RequestGuard();
    onlyErrors.markSent(0);
    onlyErrors.recordStatus(null);
    onlyErrors.markSent(2000);
    onlyErrors.recordStatus(null);
    expect(onlyErrors.sentCount).toBe(2);
    expect(onlyErrors.next(9000).allow).toBe(true);
  });

  it("本数上限と連続拒否が同時に成立した場合は、より情報量のある consecutive-blocks を返す", () => {
    const guard = new RequestGuard({ maxRequests: 2 });
    guard.markSent(0);
    guard.recordStatus(403);
    guard.markSent(2000);
    guard.recordStatus(403);
    expect(guard.sentCount).toBe(2);
    expect(guard.next(9000)).toEqual({ allow: false, reason: "consecutive-blocks" });
  });
});

describe("isAuthorized(共有秘密の照合)", () => {
  it("一致すれば true", () => {
    expect(isAuthorized("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("マルチバイトを含む値でも一致で true", () => {
    expect(isAuthorized("秘密-値", "秘密-値")).toBe(true);
  });

  it.each([
    { provided: "s3cret-valuX", expected: "s3cret-value", label: "1文字違い" },
    { provided: "s3cret", expected: "s3cret-value", label: "期待値の前方一致(短い)" },
    { provided: "s3cret-value-extra", expected: "s3cret-value", label: "期待値より長い" },
    { provided: "s3cret-value\u0000", expected: "s3cret-value", label: "期待値の末尾に NUL を足したもの(0 埋めの比較だけでは一致してしまう)" },
    { provided: "", expected: "s3cret-value", label: "空のヘッダ" },
    { provided: null, expected: "s3cret-value", label: "ヘッダなし(null)" },
    { provided: undefined, expected: "s3cret-value", label: "ヘッダなし(undefined)" },
  ])("$label は false", ({ provided, expected }) => {
    expect(isAuthorized(provided, expected)).toBe(false);
  });

  it.each([
    { provided: "", expected: "" },
    { provided: "", expected: undefined },
    { provided: undefined, expected: undefined },
    { provided: null, expected: null },
    { provided: "anything", expected: undefined },
    { provided: "anything", expected: "" },
  ])(
    "期待値(Worker の secret)が未設定・空のときは、何を送っても認可しない(provided=$provided, expected=$expected)",
    ({ provided, expected }) => {
      expect(isAuthorized(provided, expected)).toBe(false);
    },
  );
});
