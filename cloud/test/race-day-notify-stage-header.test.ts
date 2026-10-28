import { afterEach, describe, expect, it } from "vitest";

import type { ShutubaRaceInfo } from "../../packages/core/src/scraper/types";
import { NotifyStage } from "../src/race-day-notify-stage";
import { NotifyStore } from "../src/notify-store";
import { openNodeSql, type NodeSql } from "./node-sql";

/** Issue #522: `NotifyStage.recordHeaderRead`(見出しを読めなかったレースの記録)。対象は、通知が有効・自動の pre_race・中央のレースだけ。 */

const CENTRAL = "202603020211";
const NAR = "202654071210";

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

type Header = Pick<ShutubaRaceInfo, "raceName" | "courseType" | "distance" | "weather" | "trackCondition" | "fence">;
const header = (over: Partial<Header> = {}): ShutubaRaceInfo => ({ raceName: "R", courseType: "芝", distance: 1800, weather: "晴", trackCondition: "良", fence: "A", ...over }) as ShutubaRaceInfo;
const task = (raceId: string) => ({ race_id: raceId, mode: "pre_race" as const, queued_at: 1 });

function setup(options: { notifier?: boolean; auto?: boolean; store?: NotifyStore } = {}): { stage: NotifyStage; store: NotifyStore; warnings: string[] } {
  const sql = openNodeSql();
  opened.push(sql);
  sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store = options.store ?? new NotifyStore(sql);
  const warnings: string[] = [];
  const stage = new NotifyStage({
    store,
    notifier: options.notifier === false ? undefined : { send: async () => undefined },
    appBaseUrl: undefined,
    now: () => 5000,
    onWarn: (m) => warnings.push(m),
    metaGet: () => null,
    getAutoRunResults: () => ({ stage: "done", finalizedAt: 0, results: [] }),
    getPlanProgress: () => {
      throw new Error("使わない");
    },
    planRow: () => null,
    isAutoTask: () => options.auto !== false,
  });
  return { stage, store, warnings };
}

describe("NotifyStage.recordHeaderRead", () => {
  it("中央・自動・通知が有効で、馬場状態を読めなかったレースを記録し、警告(ログ)を 1 行出す", () => {
    const { stage, store, warnings } = setup();
    stage.recordHeaderRead(task(CENTRAL), header({ trackCondition: undefined, weather: undefined }));
    expect(store.headerUnreadRows()).toEqual([{ race_id: CENTRAL, missing: "馬場状態,天候", recorded_at: 5000 }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(CENTRAL);
    expect(warnings[0]).toContain("馬場状態・天候");
  });

  it("すべて読めたレースは記録しない・警告も出さない", () => {
    const { stage, store, warnings } = setup();
    stage.recordHeaderRead(task(CENTRAL), header());
    expect(store.headerUnreadRows()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("地方のレースは記録しない(読めなくても。地方は見出しの形が違う)", () => {
    const { stage, store, warnings } = setup();
    stage.recordHeaderRead(task(NAR), header({ courseType: "ダ", trackCondition: undefined, fence: undefined }));
    expect(store.headerUnreadRows()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("自動でない(手動の)タスクは記録しない", () => {
    const { stage, store } = setup({ auto: false });
    stage.recordHeaderRead(task(CENTRAL), header({ trackCondition: undefined }));
    expect(store.headerUnreadRows()).toEqual([]);
  });

  it("通知が無効(notifier なし)なら記録しない", () => {
    const { stage, store, warnings } = setup({ notifier: false });
    stage.recordHeaderRead(task(CENTRAL), header({ trackCondition: undefined }));
    expect(store.headerUnreadRows()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("記録の書き込みが失敗しても投げない。固定の警告だけを残す(例外の文面は出さない)", () => {
    const sql = openNodeSql();
    opened.push(sql);
    sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const store = new NotifyStore(sql);
    store.recordHeaderUnread = () => {
      throw new Error("SECRET-DB-DETAIL");
    };
    const { stage, warnings } = setup({ store });
    expect(() => stage.recordHeaderRead(task(CENTRAL), header({ trackCondition: undefined }))).not.toThrow();
    expect(warnings.some((w) => w.includes(CENTRAL) && w.includes("見出し"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("SECRET-DB-DETAIL");
  });
});
