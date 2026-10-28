import { describe, expect, it } from "vitest";

import { buildHeaderUnreadEmbed, buildHeaderUnreadMinimalEmbed, EMBED_LIMITS, type RaceLabel } from "../src/notify-embeds";
import { DISCORD_COLORS } from "../src/palette";
import { embedLength } from "./support/embed-length";

/** Issue #522: 見出しを読めなかったレースの通知の embed(純関数)。 */

const label = (over: Partial<RaceLabel> = {}): RaceLabel => ({ raceId: "202605040105", venueName: "東京", raceNumber: 5, raceName: "テスト特別", startTime: "11:20", ...over });
const lines = (e: { description?: string }): string[] => (e.description ?? "").split("\n");

describe("buildHeaderUnreadEmbed", () => {
  const base = { kaisaiDate: "20261029", summary: { races: 3, track: 3, fence: 1, weather: 2 }, example: { label: label(), items: ["馬場状態", "天候"] as const } };

  it("見出しは日付(曜日つき)。色は橙。色に頼らず【要確認】の語でも伝える", () => {
    const e = buildHeaderUnreadEmbed(base);
    expect(e.title).toBe("出馬表の見出しを読めませんでした 2026/10/29(木)");
    expect(e.color).toBe(DISCORD_COLORS.warn);
    expect(lines(e)[0]).toBe("【要確認】本日の中央のレース 3 件で、出馬表の見出しから馬場状態か芝の柵を読めませんでした。");
  });

  it("件数: 馬場状態・柵・天候(きっかけのあったレースのうち天候も読めなかった数)を出す", () => {
    const e = buildHeaderUnreadEmbed(base);
    expect(e.description).toContain("読めなかった項目: 馬場状態 3 件 / 柵(芝) 1 件 / 天候も読めなかったレース 2 件");
  });

  it("未発表のときも同じように読めない注記と、影響の説明と、1 日 1 回の注記が残る", () => {
    const text = buildHeaderUnreadEmbed(base).description!;
    expect(text).toContain("netkeiba の表示の形が変わった可能性があります");
    expect(text).toContain("未発表のときも同じように読めません");
    expect(text).toContain("道悪の補正がかからず");
    expect(text).toContain("この通知は 1 日に 1 回です");
  });

  it("馬場状態が 0 件なら馬場状態の影響の文は出さず、柵が 0 件なら柵の影響の文は出さない(事実に合わせる)", () => {
    const onlyFence = buildHeaderUnreadEmbed({ ...base, summary: { races: 1, track: 0, fence: 1, weather: 0 }, example: { label: label(), items: ["柵"] } }).description!;
    expect(onlyFence).not.toContain("道悪の補正がかからず");
    expect(onlyFence).toContain("柵の日数");
    const onlyTrack = buildHeaderUnreadEmbed({ ...base, summary: { races: 1, track: 1, fence: 0, weather: 0 }, example: { label: label(), items: ["馬場状態"] } }).description!;
    expect(onlyTrack).toContain("道悪の補正がかからず");
    expect(onlyTrack).not.toContain("柵の日数");
  });

  it("例は 1 つ: 場・R・レース名と、読めなかった項目", () => {
    const e = buildHeaderUnreadEmbed(base);
    expect(e.fields).toEqual([{ name: "例(最初に見つかったレース)", value: "東京 5R テスト特別: 馬場状態・天候" }]);
  });

  it("外から来た文字(会場名・レース名)は書式を無害化する", () => {
    const e = buildHeaderUnreadEmbed({ ...base, example: { label: label({ raceName: "**太字**@everyone" }), items: ["馬場状態"] } });
    expect(e.fields![0]!.value).not.toContain("**太字**");
    expect(e.fields![0]!.value).toContain("\\*\\*太字\\*\\*");
  });

  it("上限を守る(長いレース名でも全体 6000 以内、各 field の上限以内)", () => {
    const e = buildHeaderUnreadEmbed({ ...base, example: { label: label({ raceName: "あ".repeat(3000) }), items: ["馬場状態", "柵", "天候"] } });
    expect(embedLength(e)).toBeLessThanOrEqual(EMBED_LIMITS.total);
    expect(e.fields![0]!.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
    expect(e.fields![0]!.value.length).toBeGreaterThan(100); // 前提: 長い入力が実際に渡っている(空振りでない)
  });

  it("開催日が不正なら『日付不明』(曜日を捏造しない)", () => {
    expect(buildHeaderUnreadEmbed({ ...base, kaisaiDate: "xx" }).title).toBe("出馬表の見出しを読めませんでした 日付不明");
  });
});

describe("buildHeaderUnreadMinimalEmbed(組み立てに失敗したときの最小の通知)", () => {
  it("固定文と日付だけ", () => {
    const e = buildHeaderUnreadMinimalEmbed("20261029");
    expect(e.title).toBe("出馬表の見出しを読めませんでした 2026/10/29(木)");
    expect(e.description).toContain("【要確認】");
    expect(e.description).toContain("画面で確認してください");
    expect(e.color).toBe(DISCORD_COLORS.warn);
    expect(e.fields).toBeUndefined();
  });
});
