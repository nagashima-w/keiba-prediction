import { describe, expect, it } from "vitest";

import { parseHash } from "../client/route";
import { buildAnalysisLink, resolveAppBaseUrl } from "../src/notify-link";

/**
 * Issue #230: 通知のリンク(分析画面)。サイトの URL は公開リポジトリに書けないので、Worker の secret `APP_BASE_URL` から読む。
 * 検証は「https のオリジンだけ」。未登録・不正な形ならリンクを省く(通知は送る)。値はログにも出さない(このテストは値の検証だけ)。
 * ここで使うホストは、文書用のダミー(example.test。実在のサイトではない)。
 */

describe("resolveAppBaseUrl(Issue #230 Q7: https のオリジンだけを受け付ける)", () => {
  it.each([
    ["未登録(undefined)", undefined],
    ["空文字", ""],
    ["空白だけ", "  \n\t "],
    ["文字列でない値(型の防御)", 123 as unknown as string],
  ] as const)("%s → absent", (_name, value) => {
    expect(resolveAppBaseUrl(value)).toEqual({ status: "absent" });
  });

  it.each([
    ["https のオリジン", "https://keiba.example.test", "https://keiba.example.test"],
    ["末尾の / は取り除く", "https://keiba.example.test/", "https://keiba.example.test"],
    ["前後の空白・末尾の改行は取り除く(貼り付けで付く)", "  https://keiba.example.test/\n", "https://keiba.example.test"],
    ["ポート付き", "https://keiba.example.test:8443", "https://keiba.example.test:8443"],
    ["ホスト名は小文字に正規化される", "https://KEIBA.Example.Test", "https://keiba.example.test"],
    ["workers.dev のサブドメイン", "https://keiba-cloud.sub.workers.dev", "https://keiba-cloud.sub.workers.dev"],
  ] as const)("%s → valid(%s)", (_name, value, origin) => {
    expect(resolveAppBaseUrl(value)).toEqual({ status: "valid", origin });
  });

  it.each([
    ["http(https でない)", "http://keiba.example.test"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["ftp:", "ftp://keiba.example.test"],
    ["スキームなし", "keiba.example.test"],
    ["ユーザー名つき(userinfo)", "https://user@example.com"],
    ["ユーザー名・パスワードつき", "https://user:pass@example.com"],
    ["パスつき", "https://keiba.example.test/app"],
    ["パスが // ", "https://keiba.example.test//"],
    ["クエリつき", "https://keiba.example.test?x=1"],
    ["空のクエリ(? だけ)", "https://keiba.example.test/?"],
    ["フラグメントつき", "https://keiba.example.test/#x"],
    ["空のフラグメント(# だけ)", "https://keiba.example.test#"],
    ["ホストなし", "https://"],
    ["内部に空白", "https://keiba example.test"],
    ["内部のタブ(URL の解釈は黙って取り除くので、文字列の段階で拒否する)", "https://keiba.exa\tmple.test"],
    ["改行が途中に入る", "https://keiba.example.test\nhttps://other.example.test"],
  ] as const)("%s → invalid", (_name, value) => {
    expect(resolveAppBaseUrl(value)).toEqual({ status: "invalid" });
  });

  it("invalid の結果に、入力の値(の一部)が含まれない(ログ・応答に値を出す経路を作らない)", () => {
    const bad = "https://user:SECRET-PASS@example.com/app";
    expect(JSON.stringify(resolveAppBaseUrl(bad))).not.toContain("SECRET-PASS");
    expect(JSON.stringify(resolveAppBaseUrl(bad))).not.toContain("example.com");
  });
});

describe("buildAnalysisLink(Issue #230 Q6: クライアントの `parseHash` が読める形)", () => {
  const origin = "https://keiba.example.test";
  const TODAY = "20260101";

  it("中央: オリジン + / + #date=…&venue=central&race=…&analysis=…", () => {
    expect(buildAnalysisLink(origin, { date: "20260628", venue: "central", raceId: "202603020211", analysisId: 42 })).toBe(
      "https://keiba.example.test/#date=20260628&venue=central&race=202603020211&analysis=42",
    );
  });

  it("地方: venue=nar", () => {
    expect(buildAnalysisLink(origin, { date: "20260628", venue: "nar", raceId: "202636062811", analysisId: 7 })).toBe(
      "https://keiba.example.test/#date=20260628&venue=nar&race=202636062811&analysis=7",
    );
  });

  it.each([
    ["中央", "central", "202603020211"],
    ["地方", "nar", "202636062811"],
  ] as const)("パリティ(%s): 組み立てたリンクのハッシュを、クライアントの parseHash で読み戻すと、元の値になる", (_name, venue, raceId) => {
    const link = buildAnalysisLink(origin, { date: "20260628", venue, raceId, analysisId: 12345 })!;
    const route = parseHash(new URL(link).hash, TODAY);
    expect(route).toMatchObject({ date: "20260628", venue, race: raceId, analysis: 12345, settings: false });
    expect(new URL(link).origin).toBe(origin);
  });

  it.each([
    ["0", 0],
    ["負", -1],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["サーバの上限 2147483647 を超える", 2_147_483_648],
  ] as const)("分析 id が正の整数でない(%s)ときは、リンクを作らない(undefined)", (_name, analysisId) => {
    expect(buildAnalysisLink(origin, { date: "20260628", venue: "central", raceId: "202603020211", analysisId })).toBeUndefined();
  });

  it("分析 id の上限ちょうど(2147483647)は作る", () => {
    expect(buildAnalysisLink(origin, { date: "20260628", venue: "central", raceId: "202603020211", analysisId: 2_147_483_647 })).toContain("analysis=2147483647");
  });

  it("日付が 8 桁でない・レース ID が 12 桁でないときは、その項目を省いて分析 id だけで作る(画面は既定の今日・中央に落ちるが、分析は開ける)", () => {
    const link = buildAnalysisLink(origin, { date: "2026-06-28", venue: "central", raceId: "bad", analysisId: 5 })!;
    expect(link).toBe("https://keiba.example.test/#analysis=5");
    expect(parseHash(new URL(link).hash, TODAY)).toMatchObject({ analysis: 5, race: null });
  });
});
