/**
 * エラーコピー用テキスト組み立て(renderer/error-copy.ts)の純関数テスト。Task#36 受け入れ条件3。
 *
 * 「このエラーのログをコピー」ボタンでクリップボードへ書き込む文字列を組み立てる。
 * ユーザーがそのままAIへ貼り付けられるよう、1回のコピーで自己完結するテキストにする
 * (操作名・エラーメッセージ・関連コンテキスト(raceId等)を含む)。
 */

import { describe, expect, it } from "vitest";

import { buildErrorCopyText } from "../src/renderer/error-copy.js";

describe("buildErrorCopyText(コピー用テキストの組み立て)", () => {
  it("操作名とメッセージを含む複数行テキストを組み立てる", () => {
    const text = buildErrorCopyText({
      operation: "検証:結果取込",
      message: "ネットワークエラー",
    });
    expect(text).toContain("操作: 検証:結果取込");
    expect(text).toContain("エラー: ネットワークエラー");
  });

  it("コンテキスト(raceId等)があれば行として追加する", () => {
    const text = buildErrorCopyText({
      operation: "検証:結果取込",
      message: "ネットワークエラー",
      context: { raceId: "202601010101" },
    });
    expect(text).toContain("raceId: 202601010101");
  });

  it("コンテキストの値が null/undefined/空文字なら省略する(無意味な行を作らない)", () => {
    const text = buildErrorCopyText({
      operation: "検証:履歴取得",
      message: "失敗",
      context: { raceId: null, url: undefined, note: "" },
    });
    expect(text).not.toContain("raceId:");
    expect(text).not.toContain("url:");
    expect(text).not.toContain("note:");
  });

  it("コンテキスト省略時は操作行とエラー行のみになる", () => {
    const text = buildErrorCopyText({
      operation: "設定:保存",
      message: "書き込み失敗",
    });
    expect(text).toBe("操作: 設定:保存\nエラー: 書き込み失敗");
  });

  it("複数のコンテキスト項目を渡した順に行として並べる", () => {
    const text = buildErrorCopyText({
      operation: "一括分析:レース",
      message: "分析に失敗しました",
      context: { raceId: "202601010101", venueKind: "central" },
    });
    expect(text).toBe(
      "操作: 一括分析:レース\nエラー: 分析に失敗しました\nraceId: 202601010101\nvenueKind: central",
    );
  });

  it("複数行メッセージ(一括取込失敗の複数レース分等)は「エラー一覧:」見出し+改行で整形する", () => {
    // VerifyView.tsx の一括取込失敗ボタンは formatFailedRaceErrors で組み立てた
    // 「raceId: message」を1行1レースとした複数行文字列を message に渡す。
    // 「エラー: ${message}」のまま連結すると1件目にだけ「エラー: 」が付き、
    // 2件目以降がプレフィックス無しで裸のまま並んでしまうため、複数行のときは
    // 見出しを独立させて全行を見出しの下に揃える。
    const text = buildErrorCopyText({
      operation: "検証:結果の一括取込",
      message: "202601010101: ネットワークエラー\n202601010102: パースエラー",
    });
    expect(text).toBe(
      "操作: 検証:結果の一括取込\nエラー一覧:\n202601010101: ネットワークエラー\n202601010102: パースエラー",
    );
  });

  it("複数行メッセージでもコンテキストは末尾に続けて付与する", () => {
    const text = buildErrorCopyText({
      operation: "検証:結果の一括取込",
      message: "202601010101: ネットワークエラー\n202601010102: パースエラー",
      context: { raceCount: "2" },
    });
    expect(text).toBe(
      "操作: 検証:結果の一括取込\nエラー一覧:\n202601010101: ネットワークエラー\n202601010102: パースエラー\nraceCount: 2",
    );
  });
});
