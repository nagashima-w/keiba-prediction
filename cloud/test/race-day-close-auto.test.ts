import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { CloseSavePayload } from "../src/analysis-close";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #338(#335-A1): 締切の直前の再計算は、**自動の発走前の分析**(計画の期限で昇格した pre_race)でも動く(自動の印を見ない)。
 * 自動の実行の流れ(計画 → 期限で昇格 → 取得 → 計算 → 保存)を通し、保存の直後に積まれた回の行が、発走の 5 分前・2 分前に動いて D1(偽)に保存されることを確かめる。
 * 通知(notifier)は偽を渡し、再計算の前後で送信の件数・通知の表の行が増えないことを確かめる(通知しない=ユーザー決定 2026-10-16)。開催日 20260628(福島 11R の実フィクスチャ 202603020211。発走 15:45 JST)。
 */

const DATE = "20260628";
const RACE = "202603020211";
const jst = (time: string): number => Date.parse(`2026-06-28T${time}:00+09:00`);
const encoder = new TextEncoder();
const bytes = (text: string): ArrayBuffer => {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};

const LIST_HTML = `<dl class="RaceList_DataList">
<dt class="RaceList_DataHeader"><p class="RaceList_DataTitle"><small>1回</small> 福島 <small>1日目</small></p></dt>
<dd class="RaceList_Data"><ul>
<li class="RaceList_DataItem">
<a href="../race/shutuba.html?race_id=${RACE}&rf=race_list">
<div class="Race_Num"><span>11R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle"><span class="ItemTitle">福島記念テスト</span></div>
<div class="RaceData"><span class="RaceList_Itemtime">15:45 </span><span class="Dart">ダ1200m</span>16頭</div>
</div>
</a>
</li>
</ul></dd>
</dl>`;
const EMPTY_HTML = "<html><body></body></html>";

const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });

interface Fake extends GateLike {
  readonly urls: string[];
}

function fakeGate(): Fake {
  const gate: Fake = {
    urls: [],
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return ok(LIST_HTML);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return ok(EMPTY_HTML);
      return ok(fixtureForUrl(url));
    },
  };
  return gate;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

describe("締切の直前の再計算: 自動の発走前の分析でも動く(Issue #338)", () => {
  it("計画 → 期限(発走 45 分前)で昇格した pre_race が保存されると、回の行が積まれ、15:40 と 15:43 に起きて 2 回とも ok で保存される。通知は増えない(Discord に送る件数も、通知の表の行も、再計算で変わらない)", async () => {
    const sql = opened[opened.push(openNodeSql()) - 1]!;
    const clock = { now: jst("08:00") };
    const alarm: { at: number | null } = { at: null };
    const gate = fakeGate();
    const saved: AnalysisRecord[] = [];
    const closes: { analysisId: number; payload: CloseSavePayload }[] = [];
    const sink: AnalysisSink = {
      async save(record) {
        saved.push(record);
        return { id: saved.length, detail: "stored" };
      },
      async findByAnalyzedAt(raceId, analyzedAt) {
        const index = saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
        return index < 0 ? null : index + 1;
      },
      async findRecentByRace() {
        return [];
      },
      async countChildren(id) {
        const rec = saved[id - 1]!;
        return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
      },
      async saveClose(analysisId, payload) {
        closes.push({ analysisId, payload });
      },
    };
    const settings: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, includeComboOdds: false, baseScoreWeightJockey: 0 };
    const sent: unknown[] = [];
    const notifier = { send: async (payload: unknown) => void sent.push(payload) };
    const core = new RaceDayCore({ sql, now: () => clock.now, gate, setAlarm: (at) => void (alarm.at = at), onWarn: () => undefined, sink, loadSettings: async () => settings, notifier });
    const tick = async (): Promise<StepOutcome> => {
      const at = alarm.at;
      if (at === null) throw new Error("アラームが無い");
      clock.now = Math.max(clock.now, at);
      alarm.at = null;
      return core.runNextStep();
    };
    const drive = async (until: number, max = 60): Promise<string[]> => {
      const out: string[] = [];
      for (let i = 0; i < max; i += 1) {
        if (alarm.at === null || alarm.at > until) return out;
        const o = await tick();
        out.push(o.kind === "idle" ? "idle" : `${o.mode}:${o.step}:${o.result}`);
      }
      throw new Error("アラームが止まらない");
    };

    expect(await core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
    for (let i = 0; i < 3; i += 1) await tick(); // 一覧 2 つ + 確定
    sql.exec("UPDATE race_day_tasks SET status = 'done' WHERE mode = 'morning'"); // 朝は主題ではない
    // 期限(15:00)まで進める: 昇格 → 取得 → 計算
    const before = await drive(jst("15:30"));
    expect(before).toContain("pre_race:compute:ok");
    // 自動の印がある(= 手動ではなく自動の pre_race)ことを前提として固定する
    expect((sql.exec("SELECT COUNT(*) AS n FROM race_day_auto_pre_race WHERE race_id = ?", RACE).toArray() as { n: number }[])[0]!.n).toBe(1);
    const rows = sql.exec("SELECT round, due_ms, state FROM race_day_close WHERE race_id = ? ORDER BY round", RACE).toArray() as { round: number; due_ms: number; state: string }[];
    expect(rows).toEqual([
      { round: 1, due_ms: jst("15:40"), state: "pending" },
      { round: 2, due_ms: jst("15:43"), state: "pending" },
    ]);
    expect(closes).toHaveLength(0);
    // 15:40 と 15:43 に起きる
    const urlsBefore = gate.urls.length;
    const sentBefore = sent.length;
    const notifyKeysBefore = (sql.exec("SELECT key FROM race_day_notify ORDER BY key").toArray() as { key: string }[]).map((r) => r.key);
    expect(notifyKeysBefore).toContain(`race:${RACE}`); // 前提: 通知の仕組みは有効で、自動の分析の完了の通知は積まれている(再計算の通知が無いことを、空振りなしで確かめる)
    const after = await drive(jst("15:44"));
    expect(sent).toHaveLength(sentBefore);
    expect((sql.exec("SELECT key FROM race_day_notify ORDER BY key").toArray() as { key: string }[]).map((r) => r.key)).toEqual(notifyKeysBefore);
    expect(after.filter((x) => x.startsWith("close:"))).toEqual(["close:recompute:ok", "close:recompute:ok"]);
    expect(closes.map((c) => [c.analysisId, c.payload.round, c.payload.status, c.payload.lateMs])).toEqual([
      [1, 1, "ok", 0],
      [1, 2, "ok", 0],
    ]);
    expect(gate.urls.length - urlsBefore).toBe(2); // 組合せ OFF なので、各回 1 本(単勝複勝)
  });
});
