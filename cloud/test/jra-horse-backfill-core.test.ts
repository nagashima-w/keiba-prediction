import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isJraHorseBackfillDisabled,
  JraHorseBackfillCore,
  type HorseFetchOutcome,
  type JraHorseBackfillOptions,
} from "../src/jra-horse-backfill-core";
import { horseCnameSuffix } from "../src/jra-horse-cname";
import type { JraHorseStoreLike, SavedHorseProfile } from "../src/jra-horse-repository";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #697: 馬の頁の属性を埋め戻す段取り(`JraHorseBackfillCore`)。時計・アラーム・JRA への取得・D1 は偽物。DO の SQLite は本物の SQLite(node:sqlite)。
 * 時刻は JST で書く(`jst(日, 時, 分, 秒)`。2026-11 の日)。
 */

/** 2026-11-<日> <時>:<分>:<秒> JST のエポックミリ秒。 */
const jst = (day: number, h: number, mi = 0, s = 0): number => Date.UTC(2026, 10, day, h - 9, mi, s);

/** 計算できる馬の ID(2 桁目 0・5 桁目 1)。n は 1 から。 */
const hid = (n: number): string => `20181${String(n).padStart(5, "0")}`;

const profileHtml = (name: string): string =>
  `<html><head><title>競走馬情報　JRA</title></head><body><h1><span class="inner"><span class="txt"><span class="opt">競走馬情報</span>${name}<span class="name_en">x</span></span></span></h1>` +
  `<div class="profile"><div class="data"><ul><li><dl><dt>父</dt><dd>父${name}</dd></dl></li><li><dl><dt>母</dt><dd>母${name}<span class="sanku">産駒</span></dd></dl></li><li><dl><dt>母の父</dt><dd>母父${name}</dd></dl></li><li><dl><dt>生産牧場</dt><dd>牧場${name}</dd></dl></li></ul></div></div></body></html>`;
const PARAM_ERROR_HTML = "<html><head><title>パラメータエラー　JRA</title></head><body></body></html>";

class FakeStore implements JraHorseStoreLike {
  runs: string[] = [];
  present = new Set<string>();
  inserted: { profiles: SavedHorseProfile[]; today: string }[] = [];
  listCalls: { cursor: string; limit: number }[] = [];
  failInsert = false;
  async listHorseIdsAfter(cursor: string, limit: number): Promise<string[]> {
    this.listCalls.push({ cursor, limit });
    return [...this.runs].sort().filter((id) => id > cursor).slice(0, limit);
  }
  async filterMissing(ids: readonly string[]): Promise<string[]> {
    return ids.filter((id) => !this.present.has(id));
  }
  async insertProfiles(profiles: readonly SavedHorseProfile[], today: string): Promise<number> {
    if (this.failInsert) throw new Error("D1 down");
    this.inserted.push({ profiles: [...profiles], today });
    let changes = 0;
    for (const p of profiles) {
      if (!this.present.has(p.horseId)) {
        this.present.add(p.horseId);
        changes += 1;
      }
    }
    return changes;
  }
}

class Harness {
  sql: NodeSql = openNodeSql();
  now = jst(10, 20);
  alarm: number | null = null;
  store = new FakeStore();
  /** 馬の ID → 取得の結果。未指定は成功の頁。 */
  outcomes = new Map<string, HorseFetchOutcome>();
  fetched: { id: string; suffix: string; at: number }[] = [];
  logs: string[] = [];
  sleeps: number[] = [];
  /** 1 回の取得にかかる時間(ミリ秒)。 */
  fetchMs = 0;
  core: JraHorseBackfillCore;

  constructor(options: JraHorseBackfillOptions = {}) {
    this.core = new JraHorseBackfillCore(
      {
        sql: this.sql,
        now: () => this.now,
        sleep: async (ms) => {
          this.sleeps.push(ms);
          this.now += ms;
        },
        setAlarm: (at) => {
          this.alarm = at;
        },
        getAlarm: async () => this.alarm,
        store: this.store,
        fetchProfile: async (id, suffix) => {
          this.fetched.push({ id, suffix, at: this.now });
          this.now += this.fetchMs;
          return this.outcomes.get(id) ?? { kind: "page", html: profileHtml(`馬${id}`) };
        },
        log: (line) => this.logs.push(line),
      },
      options,
    );
  }

  setRuns(n: number): void {
    this.store.runs = Array.from({ length: n }, (_, i) => hid(i + 1));
  }

  meta(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM hb_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }

  skips(): { horse_id: string; reason: string }[] {
    return this.sql.exec("SELECT horse_id, reason FROM hb_skip ORDER BY horse_id").toArray() as { horse_id: string; reason: string }[];
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => {
  h.sql.close();
});

describe("前提(テスト用の馬の ID)", () => {
  it("hid(n) は 10 桁で、2 桁目 0・5 桁目 1 の計算できる ID。n が違えば ID も違う", () => {
    for (const n of [1, 2, 40, 41, 150]) {
      expect(hid(n)).toMatch(/^[0-9]{10}$/);
      expect(horseCnameSuffix(hid(n)), String(n)).not.toBeNull();
    }
    expect(new Set([1, 2, 3, 40, 41, 150].map(hid)).size).toBe(6);
    expect(hid(1) < hid(2) && hid(2) < hid(41) && hid(41) < hid(150), "昇順").toBe(true);
  });
});

describe("isJraHorseBackfillDisabled", () => {
  it("文字列 \"0\"(前後の空白は無視)だけが無効。未設定・\"1\"・空・その他は有効", () => {
    expect(isJraHorseBackfillDisabled("0")).toBe(true);
    expect(isJraHorseBackfillDisabled(" 0 ")).toBe(true);
    for (const v of [undefined, "1", "", "00", "false", "off"]) expect(isJraHorseBackfillDisabled(v), String(v)).toBe(false);
  });
});

describe("起床 1 回: 取って書く", () => {
  it("いない馬だけ取って馬名・父・母・母の父・生産者(産駒は除く)を書く。取得日は JST の YYYYMMDD。いる馬は取らない", async () => {
    h.setRuns(3);
    h.store.present.add(hid(2));
    await h.core.runNextStep();
    expect(h.fetched.map((f) => f.id)).toEqual([hid(1), hid(3)]);
    expect(h.store.inserted).toHaveLength(1);
    expect(h.store.inserted[0]!.today).toBe("20261110");
    expect(h.store.inserted[0]!.profiles).toEqual([
      { horseId: hid(1), name: `馬${hid(1)}`, sire: `父馬${hid(1)}`, dam: `母馬${hid(1)}`, damSire: `母父馬${hid(1)}`, breeder: `牧場馬${hid(1)}` },
      { horseId: hid(3), name: `馬${hid(3)}`, sire: `父馬${hid(3)}`, dam: `母馬${hid(3)}`, damSire: `母父馬${hid(3)}`, breeder: `牧場馬${hid(3)}` },
    ]);
  });

  it("取得口には馬の ID と、計算した 2 桁を渡す", async () => {
    h.setRuns(1);
    await h.core.runNextStep();
    expect(h.fetched[0]!.id).toBe(hid(1));
    expect(h.fetched[0]!.suffix).toBe(horseCnameSuffix(hid(1)));
    expect(h.fetched[0]!.suffix).toMatch(/^[0-9A-F]{2}$/);
  });

  it("1 起床で最大 40 頭。41 頭目は次の起床で取る。間は 3 秒以上あけ、次のアラームは終わってから 30 秒後", async () => {
    h.setRuns(45);
    h.fetchMs = 800;
    await h.core.runNextStep();
    expect(h.fetched).toHaveLength(40);
    const gaps = h.fetched.slice(1).map((f, i) => f.at - h.fetched[i]!.at);
    expect(gaps).toHaveLength(39);
    expect(Math.min(...gaps), "開始から開始まで 3 秒以上").toBeGreaterThanOrEqual(3000);
    expect(h.sleeps.length, "2 本目から待つ").toBe(39);
    expect(h.alarm).toBe(h.now + 30_000);
    expect(h.meta("cursor")).toBe(hid(40));
    await h.core.runNextStep();
    expect(h.fetched.slice(40).map((f) => f.id)).toEqual([hid(41), hid(42), hid(43), hid(44), hid(45)]);
  });

  it("応答に 3 秒以上かかったときは、さらに待たない(開始から開始までで数える)", async () => {
    h.setRuns(2);
    h.fetchMs = 3500;
    await h.core.runNextStep();
    expect(h.sleeps).toEqual([]);
  });

  it("対象が 100 頭を超えても、1 回の読み出しは 100 頭までの範囲読み(全走査しない)", async () => {
    h.setRuns(150);
    h.store.present = new Set(h.store.runs); // 全員いる
    await h.core.runNextStep();
    expect(h.store.listCalls).toEqual([{ cursor: "", limit: 100 }]);
    expect(h.fetched).toHaveLength(0);
    expect(h.meta("cursor")).toBe(hid(100));
  });
});

describe("時間帯(JST 18:00〜翌 8:00)", () => {
  const cases: [string, number, boolean, number][] = [
    // 名前, 時刻, 動くか, 動かないときの次のアラーム
    ["17:59:59 は動かない", jst(10, 17, 59, 59), false, jst(10, 18)],
    ["18:00:00 は動く", jst(10, 18), true, 0],
    ["23:59:59 は動く", jst(10, 23, 59, 59), true, 0],
    ["0:00:00 は動く", jst(11, 0), true, 0],
    ["7:59:59 は動く", jst(11, 7, 59, 59), true, 0],
    ["8:00:00 は動かない", jst(11, 8), false, jst(11, 18)],
    ["12:00 は動かない", jst(11, 12), false, jst(11, 18)],
  ];
  for (const [name, at, runs, next] of cases) {
    it(name, async () => {
      h.setRuns(2);
      h.now = at;
      await h.core.runNextStep();
      expect(h.fetched.length > 0, "前提: 動いたかどうか").toBe(runs);
      if (!runs) {
        expect(h.alarm).toBe(next);
        expect(h.store.listCalls, "D1 も読まない").toEqual([]);
      }
    });
  }

  it("取っている途中で 8:00 を過ぎたら、その先は取らない(取れた分は書き、カーソルはそこまで)", async () => {
    h.setRuns(10);
    h.now = jst(11, 7, 59, 50);
    h.fetchMs = 4000; // 1 本ごとに 4 秒 → 3 本目の前で 8:00 を過ぎる
    await h.core.runNextStep();
    expect(h.fetched.length).toBeGreaterThanOrEqual(2);
    expect(h.fetched.length).toBeLessThan(10);
    expect(h.fetched.every((f) => f.at < jst(11, 8))).toBe(true);
    expect(h.store.inserted[0]!.profiles).toHaveLength(h.fetched.length);
    expect(h.meta("cursor")).toBe(h.fetched[h.fetched.length - 1]!.id);
  });
});

describe("1 日の書き込みの枠(horse_profiles の行 15,000 行/JST の日)", () => {
  it("書いた行数(insertProfiles の返り値)を日ごとに数える。すでにいて書けなかった馬は数えない", async () => {
    h.setRuns(3);
    const original = h.store.insertProfiles.bind(h.store);
    h.store.insertProfiles = async (p, t) => {
      await original(p, t);
      return p.length - 1; // 1 頭は競合で書けなかった
    };
    await h.core.runNextStep();
    expect(h.meta("day_rows")).toBe("2");
    expect(h.meta("day")).toBe("20261110");
  });

  it("残り枠が 1 行なら 1 頭だけ取る。枠が 0 になったら取らず、翌日の 18:00 まで休む", async () => {
    h.setRuns(5);
    h.sql.exec("CREATE TABLE IF NOT EXISTS hb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    h.sql.exec("INSERT INTO hb_meta (key, value) VALUES ('day', '20261110'), ('day_rows', '14999')");
    await h.core.runNextStep();
    expect(h.fetched).toHaveLength(1);
    expect(h.meta("day_rows")).toBe("15000");
    h.fetched.length = 0;
    h.now = jst(10, 21);
    await h.core.runNextStep();
    expect(h.fetched).toHaveLength(0);
    expect(h.alarm).toBe(jst(11, 18));
  });

  it("日付(JST)が変わったら枠が戻る。0 時をまたいだ最初の起床から数え直す", async () => {
    h.setRuns(5);
    h.sql.exec("CREATE TABLE IF NOT EXISTS hb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    h.sql.exec("INSERT INTO hb_meta (key, value) VALUES ('day', '20261110'), ('day_rows', '15000')");
    h.now = jst(11, 0, 0, 1);
    await h.core.runNextStep();
    expect(h.fetched).toHaveLength(5);
    expect(h.meta("day")).toBe("20261111");
    expect(h.meta("day_rows")).toBe("5");
  });

  it("翌日の 18:00 は、0 時を過ぎてから超えたときも「その日の翌日」(1:00 に超えたら翌日 18:00)", async () => {
    h.setRuns(5);
    h.sql.exec("CREATE TABLE IF NOT EXISTS hb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    h.sql.exec("INSERT INTO hb_meta (key, value) VALUES ('day', '20261111'), ('day_rows', '15000')");
    h.now = jst(11, 1);
    await h.core.runNextStep();
    expect(h.alarm).toBe(jst(12, 18));
  });

  it("var で枠を下げられる(10 → 10 行で止まる)。上げる指定(15,001 以上)・不正な指定は 15,000 のまま", async () => {
    const make = (dailyRows: number | undefined) => new Harness(dailyRows === undefined ? {} : { dailyRows });
    const lowered = make(3);
    lowered.setRuns(10);
    await lowered.core.runNextStep();
    expect(lowered.fetched).toHaveLength(3);
    lowered.sql.close();
    for (const bad of [15_001, 0, -1, 1.5, Number.NaN]) {
      const x = make(bad);
      x.setRuns(41);
      await x.core.runNextStep();
      expect(x.fetched.length, `枠 ${bad} は無視して 1 起床の上限 40`).toBe(40);
      x.sql.close();
    }
  });
});

describe("飛ばす馬の記録", () => {
  it("誤りの頁(param-error)・馬名の読めない頁(unparsable)・結果の頁(not-profile)・大きすぎる頁(too-large)は記録して飛ばし、次の周でも取りに行かない", async () => {
    h.setRuns(6);
    h.outcomes.set(hid(1), { kind: "page", html: PARAM_ERROR_HTML });
    h.outcomes.set(hid(2), { kind: "page", html: "<html><head><title>競走馬情報　JRA</title></head><body></body></html>" });
    h.outcomes.set(hid(3), { kind: "page", html: "<html><head><title>レース結果　JRA</title></head><body></body></html>" });
    h.outcomes.set(hid(4), { kind: "failed", reason: "too-large" });
    await h.core.runNextStep();
    expect(h.skips()).toEqual([
      { horse_id: hid(1), reason: "param-error" },
      { horse_id: hid(2), reason: "unparsable" },
      { horse_id: hid(3), reason: "not-profile" },
      { horse_id: hid(4), reason: "too-large" },
    ]);
    expect(h.store.inserted[0]!.profiles.map((p) => p.horseId)).toEqual([hid(5), hid(6)]);
    // 次の周(カーソルは末尾で先頭に戻っている)。5・6 は書かれて入っている。飛ばした 4 頭はいない馬のままだが、取りに行かない
    expect(h.meta("cursor")).toBe("");
    h.fetched.length = 0;
    await h.core.runNextStep();
    expect(h.fetched).toEqual([]);
  });

  it("計算できない ID(2 桁目が 0/9 以外・5 桁目が 1 以外・10 桁でない)は、取りに行かず記録して飛ばす", async () => {
    h.store.runs = ["2518106541", "2018006541", "201810654", hid(1)];
    await h.core.runNextStep();
    expect(h.fetched.map((f) => f.id)).toEqual([hid(1)]);
    expect(h.skips()).toEqual([
      { horse_id: "2018006541", reason: "uncomputable" },
      { horse_id: "201810654", reason: "uncomputable" },
      { horse_id: "2518106541", reason: "uncomputable" },
    ]);
  });

  it("timeout・network・redirect・http の失敗は記録せず、次の周で再試行する", async () => {
    h.setRuns(4);
    for (const [i, reason] of (["timeout", "network", "redirect", "http"] as const).entries()) h.outcomes.set(hid(i + 1), { kind: "failed", reason });
    await h.core.runNextStep();
    expect(h.skips()).toEqual([]);
    expect(h.store.inserted).toEqual([]);
    h.outcomes.clear();
    h.fetched.length = 0;
    await h.core.runNextStep();
    expect(h.fetched.map((f) => f.id)).toEqual([hid(1), hid(2), hid(3), hid(4)]);
    expect(h.store.inserted[0]!.profiles).toHaveLength(4);
  });
});

describe("周の終わりと休み", () => {
  it("最後まで進んだらカーソルを先頭に戻す。その周で取った馬があれば、続けて動く(アラームを張る)", async () => {
    h.setRuns(3);
    await h.core.runNextStep();
    expect(h.meta("cursor")).toBe("");
    expect(h.alarm).not.toBeNull();
    expect(h.meta("wait_reason")).toBe("active");
  });

  it("1 周で取る馬が 1 頭も無かったら、アラームを張らずに休む(次の kick まで)。kick で動き出す", async () => {
    h.setRuns(3);
    h.store.present = new Set(h.store.runs);
    await h.core.runNextStep();
    expect(h.meta("cursor")).toBe("");
    expect(h.alarm).toBeNull();
    expect(h.meta("wait_reason")).toBe("idle");
    h.store.present.clear();
    await h.core.kick();
    expect(h.alarm).toBe(h.now);
    await h.core.runNextStep();
    expect(h.fetched).toHaveLength(3);
  });

  it("周の途中で取った馬があれば、周の終わりで休まない。次の周で何も取らなければ休む", async () => {
    h.setRuns(150);
    h.store.present = new Set(h.store.runs.slice(100)); // 1〜100 がいない
    await h.core.runNextStep(); // 1〜40 を取る(周の途中)
    await h.core.runNextStep(); // 41〜80
    expect(h.meta("cursor")).toBe(hid(80));
    await h.core.runNextStep(); // 81〜100 を取り、81〜150 の読みで周の端に着く
    expect(h.fetched).toHaveLength(100);
    expect(h.meta("cursor")).toBe("");
    expect(h.alarm, "この周で 100 頭取ったので、休まない").not.toBeNull();
    h.alarm = null;
    await h.core.runNextStep(); // 次の周: 1〜100 は入っている → 取るものなし(端でない)
    expect(h.meta("wait_reason")).toBe("active");
    h.alarm = null;
    await h.core.runNextStep(); // 101〜150(端)。この周は 1 頭も取らなかった
    expect(h.meta("wait_reason")).toBe("idle");
    expect(h.alarm).toBeNull();
  });

  it("取るものが無い起床(読むだけ)の次のアラームは 1 秒後。取った起床は 30 秒後", async () => {
    h.setRuns(150);
    h.store.present = new Set(h.store.runs.slice(0, 100));
    h.now = jst(10, 20);
    await h.core.runNextStep(); // 1〜100 はいる → 取らない。まだ端でない
    expect(h.fetched).toHaveLength(0);
    expect(h.alarm).toBe(h.now + 1000);
    await h.core.runNextStep(); // 101〜150 を取る
    expect(h.fetched.length).toBe(40);
    expect(h.alarm).toBe(h.now + 30_000);
  });
});

describe("続けて失敗したら止まる", () => {
  const failAll = (x: Harness): void => {
    for (const id of x.store.runs) x.outcomes.set(id, { kind: "failed", reason: "network" });
  };

  it("連続 3 回の起床で 1 頭も読めなかったら止まり、翌日 18:00 まで休む(警告のログ)。2 回では止まらない", async () => {
    h.setRuns(300);
    failAll(h);
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("active");
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("active");
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("halted");
    expect(h.alarm).toBe(jst(11, 18));
    expect(h.logs.some((l) => l.includes("halted"))).toBe(true);
  });

  it("途中で 1 頭でも読めれば連続は 0 に戻る(2 回失敗 → 成功 → 2 回失敗 では止まらない)", async () => {
    h.setRuns(400);
    failAll(h);
    await h.core.runNextStep();
    await h.core.runNextStep();
    h.outcomes.delete(hid(81)); // 3 回目の起床(81〜120)の 1 頭が読める
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("active");
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("active");
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("halted");
  });

  it("誤りの頁(param-error)ばかり返る起床も「1 頭も読めなかった」に数える(計算の誤りで全馬を飛ばし続けない)", async () => {
    h.setRuns(300);
    for (const id of h.store.runs) h.outcomes.set(id, { kind: "page", html: PARAM_ERROR_HTML });
    await h.core.runNextStep();
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("halted");
  });

  it("取る馬が無かった起床(取得 0 本)は連続に数えない", async () => {
    h.setRuns(300);
    h.store.present = new Set(h.store.runs);
    h.sql.exec("CREATE TABLE IF NOT EXISTS hb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    h.sql.exec("INSERT INTO hb_meta (key, value) VALUES ('streak', '2')");
    await h.core.runNextStep();
    expect(h.meta("streak")).toBe("2");
    expect(h.meta("wait_reason")).not.toBe("halted");
  });

  it("D1 の読み書きの例外は握って 10 分後に再試行する。連続 3 回で止まる。ログに応答の本文・URL は出さない", async () => {
    h.setRuns(5);
    h.store.failInsert = true;
    const t0 = h.now;
    await h.core.runNextStep();
    expect(h.alarm).toBe(h.now + 600_000);
    expect(h.alarm! > t0).toBe(true);
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.meta("wait_reason")).toBe("halted");
    expect(h.alarm).toBe(jst(11, 18));
    // 書けなかった馬は、カーソルも進めない(次に取り直す)
    expect(h.meta("cursor")).toBeNull();
    for (const line of h.logs) {
      expect(line, line).not.toMatch(/https?:|jra\.go\.jp|<html|CNAME|D1 down/);
    }
  });
});

describe("無効・kick", () => {
  it("無効(disabled)では kick もアラームも何もしない。起きても取らない", async () => {
    const x = new Harness({ disabled: true });
    x.setRuns(3);
    await x.core.kick();
    expect(x.alarm).toBeNull();
    await x.core.runNextStep();
    expect(x.fetched).toEqual([]);
    expect(x.store.listCalls).toEqual([]);
    x.sql.close();
  });

  it("kick: アラームが無ければ張る(時間帯の中ならいま、外なら次の 18:00)。あれば触らない", async () => {
    h.now = jst(10, 21);
    await h.core.kick();
    expect(h.alarm).toBe(jst(10, 21));
    h.alarm = jst(11, 3);
    await h.core.kick();
    expect(h.alarm).toBe(jst(11, 3));
    h.alarm = null;
    h.now = jst(11, 9);
    await h.core.kick();
    expect(h.alarm).toBe(jst(11, 18));
  });

  it("kick: 残ったまま動かないアラーム(15 分以上前)は張り直す", async () => {
    h.now = jst(10, 21);
    h.alarm = jst(10, 20, 30);
    await h.core.kick();
    expect(h.alarm).toBe(jst(10, 21));
  });
});

describe("ログ", () => {
  it("固定の文と数だけ(取った数・書いた数・飛ばした数)。URL・馬名・本文は出さない", async () => {
    h.setRuns(3);
    h.outcomes.set(hid(1), { kind: "page", html: PARAM_ERROR_HTML });
    await h.core.runNextStep();
    expect(h.logs).toEqual(["jra-horse-backfill: wake fetched=3 saved=2 skipped=1 failed=0"]);
  });
});
