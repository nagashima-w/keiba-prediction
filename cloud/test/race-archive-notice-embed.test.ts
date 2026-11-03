import { describe, expect, it } from "vitest";
import { buildArchiveNoticeEmbed } from "../src/notify-embeds";
import type { ArchiveNotice } from "../src/race-archive-fetch-core";

/**
 * Issue #554(#549-A3-3): 過去の結果の取得が止まったときの Discord の通知。固定文と数だけで、URL・例外の文面・ページの本文を含まない。
 * 色だけに頼らず、文字(【停止】【一時停止】)でも伝える。
 */

const AT = Date.UTC(2026, 10, 4, 15, 12) /* 11/5 0:12 JST */;
const RESUME = Date.UTC(2026, 10, 5, 15, 0) /* 11/6 0:00 JST */;

const text = (e: { title?: string; description?: string; fields?: readonly { name: string; value: string }[] }): string =>
  [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join("\n");

describe("buildArchiveNoticeEmbed", () => {
  it("止められた(1 回目): HTTP ステータス・段階・自動で再開する時刻・今夜の保存数と累計を出す", () => {
    const n: ArchiveNotice = { kind: "refused", httpStatus: 403, stage: "result", at: AT, willAutoResume: true, resumeAt: RESUME, nightSaved: 12, totalDone: 345 };
    const e = buildArchiveNoticeEmbed(n);
    const t = text(e);
    expect(e.title).toContain("止め");
    expect(t).toContain("【停止】");
    expect(t).toContain("HTTP 403");
    expect(t).toContain("結果ページ");
    expect(t).toContain("11/06 00:00");
    expect(t).toContain("自動で再開");
    expect(t).toContain("12");
    expect(t).toContain("345");
    expect(t).not.toContain("手で再開するまで");
  });
  it("止められた(自動再開の後): 手で再開するまで動かさないことと、再開の方法を出す", () => {
    const e = buildArchiveNoticeEmbed({ kind: "refused", httpStatus: 429, stage: "list", at: AT, willAutoResume: false, resumeAt: null, nightSaved: 0, totalDone: 10 });
    const t = text(e);
    expect(t).toContain("HTTP 429");
    expect(t).toContain("一覧");
    expect(t).toContain("手で再開するまで");
    expect(t).toContain("/api/race-archive/resume");
    expect(t).not.toContain("自動で再開します");
  });
  it.each([
    ["db-size", 412_345_678, "412"],
    ["db-size-unknown", null, "読めません"],
  ] as const)("容量(%s): 手で再開するまで動かさない。大きさ(MB)または読めなかったことを出す", (reason, bytes, expected) => {
    const t = text(buildArchiveNoticeEmbed({ kind: "capacity", reason, dbSizeBytes: bytes, at: AT, totalDone: 77 }));
    expect(t).toContain("【停止】");
    expect(t).toContain(expected);
    expect(t).toContain("手で再開するまで");
    expect(t).toContain("77");
  });
  it("R2 の柵: 次の晩に自動で再開する", () => {
    const t = text(buildArchiveNoticeEmbed({ kind: "r2-fence", at: AT, resumeAt: RESUME }));
    expect(t).toContain("R2");
    expect(t).toContain("11/06 00:00");
  });
  it("読み取り行数の予算: 読んだ行数・予算・次の晩に自動で再開することを出す", () => {
    const t = text(buildArchiveNoticeEmbed({ kind: "rows-budget", at: AT, resumeAt: RESUME, rowsRead: 1_000_123, limit: 1_000_000 }));
    expect(t).toContain("【停止】");
    expect(t).toContain("1,000,123");
    expect(t).toContain("1,000,000");
    expect(t).toContain("11/06 00:00");
  });
  it("連続失敗: その晩だけ止めたこと(止められたのではない)・件数・最後の分類・次の晩に普通に動くことを出す", () => {
    const t = text(buildArchiveNoticeEmbed({ kind: "failures", count: 10, lastClass: "http-500", at: AT, resumeAt: RESUME }));
    expect(t).toContain("【一時停止】");
    expect(t).toContain("10");
    expect(t).toContain("http-500");
    expect(t).toContain("制限されたのではなく");
  });
  it("分類の文字列に外から来る文字が入っても、そのまま載せない(英数字・ハイフン以外は落とす)", () => {
    const t = text(buildArchiveNoticeEmbed({ kind: "failures", count: 10, lastClass: "http-500 @everyone [x](https://evil.example)", at: AT, resumeAt: RESUME }));
    expect(t).not.toContain("@everyone");
    expect(t).not.toContain("evil.example");
  });
  it("URL を含めない(どの種類でも)", () => {
    const notices: ArchiveNotice[] = [
      { kind: "refused", httpStatus: 400, stage: "calendar", at: AT, willAutoResume: true, resumeAt: RESUME, nightSaved: 1, totalDone: 2 },
      { kind: "capacity", reason: "db-size", dbSizeBytes: 400_000_001, at: AT, totalDone: 3 },
      { kind: "r2-fence", at: AT, resumeAt: RESUME },
      { kind: "rows-budget", at: AT, resumeAt: RESUME, rowsRead: 5, limit: 4 },
      { kind: "failures", count: 10, lastClass: "timeout", at: AT, resumeAt: RESUME },
    ];
    for (const n of notices) {
      expect(text(buildArchiveNoticeEmbed(n)), n.kind).not.toMatch(/https?:\/\//);
    }
  });
});
