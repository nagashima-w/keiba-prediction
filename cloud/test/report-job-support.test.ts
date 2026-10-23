import { describe, expect, it } from "vitest";
import type { MessageSender } from "@keiba/core/llm";
import {
  ReportJobStore,
  attemptLlm,
  callReportLlm,
  cut,
  errorText,
  resolveNarrative,
  type JobKv,
  type LlmJobFields,
  type ReportLlmDeps,
  type StoredJobFields,
} from "../src/report-job-support";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";

/**
 * 日報・月報のジョブ機構が共有する部品(`report-job-support.ts`)の単体テスト。Issue #446(H-5)で、
 * 削除した特性テスト(`report-job-characterization.test.ts`)のうち、**挙動に関わる**場面(切り詰め・鍵の伏せ字・
 * LLM の試行の永続化・期限の来たジョブの選択・失敗の再試行・アラーム)を、共有部品そのものに対する小さなテストとして移した。
 * 日報・月報の core を通した確認は `daily-report-core.test.ts`・`monthly-report-core.test.ts` にある。
 */

// ---- cut ----

describe("cut: 文字列の切り詰め", () => {
  it("長さがちょうど max のときは切らない(max + 1 のときは切る)", () => {
    expect(cut("abcde", 5)).toBe("abcde");
    expect(cut("abcdef", 5)).toBe("abcd…");
    expect(cut("abcdef", 5)).toHaveLength(5);
    expect(cut("", 5)).toBe("");
  });

  it("末尾がサロゲートペアの前半になるときは、その前半を落として割らない(…の前に孤立したサロゲートが残らない)", () => {
    // "ab😀cd" は UTF-16 で a b \ud83d \ude00 c d。max 4 なら先頭 3 字 = "ab" + 前半 → 前半を落として "ab…"。
    const text = "ab😀cd";
    expect(text.charCodeAt(2)).toBe(0xd83d); // 前提: 3 字目がサロゲートペアの前半
    const result = cut(text, 4);
    expect(result).toBe("ab…");
    expect(result).not.toMatch(/[\ud800-\udbff]/);
    // 対照: 同じ位置が通常の文字なら落とさない。
    expect(cut("abXcd", 4)).toBe("abX…");
    // 先頭 max - 1 字がペアを丸ごと含んで終わる(末尾が後半)場合は、落とさない。
    expect(cut("a😀bcd", 4)).toBe("a😀…");
    // サロゲートの前半の範囲は U+D800〜U+DBFF(両端を含む)。端の文字でも落とす。
    expect(cut("ab\ud800cd", 4)).toBe("ab…");
    expect(cut("ab\udbffcd", 4)).toBe("ab…");
    // 範囲の外(U+DC00 = 後半の先頭、U+D7FF = 範囲の1つ手前)は落とさない。
    expect(cut("ab\udc00cd", 4)).toBe("ab\udc00…");
    expect(cut("ab\ud7ffcd", 4)).toBe("ab\ud7ff…");
  });
});

// ---- errorText ----

describe("errorText: 警告に出すエラーの文字列", () => {
  it("API キーの形(sk-ant-)は伏せる。Error でも文字列でも同じ", () => {
    expect(errorText(new Error("D1 が落ちた sk-ant-api03-ABC_def-123 のとき"))).toBe("D1 が落ちた sk-ant-*** のとき");
    expect(errorText("settings down sk-ant-SECRETKEY123456")).toBe("settings down sk-ant-***");
    expect(errorText(new Error("sk-ant-SECRETKEY123456")).includes("SECRETKEY")).toBe(false);
  });

  it("先頭 200 字に切る(ちょうど 200 字は全部、201 字は 200 字)", () => {
    expect(errorText(new Error("x".repeat(200)))).toBe("x".repeat(200));
    expect(errorText(new Error("x".repeat(201)))).toBe("x".repeat(200));
    expect(errorText(null)).toBe("null");
  });
});

// ---- callReportLlm ----

interface Warnings {
  readonly lines: string[];
}

function llmDeps(sender: MessageSender, warnings: Warnings, now = 1_000): ReportLlmDeps {
  return {
    llm: { sender },
    selectors: undefined,
    now: () => now,
    onWarn: (m) => void warnings.lines.push(m),
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
  };
}

const okSender = (text: string): MessageSender => async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 } });
const failSender = (status: number | undefined): MessageSender => async () => {
  throw status === undefined ? new Error("boom") : Object.assign(new Error("boom"), { status });
};

describe("callReportLlm: LLM を 1 回呼ぶ", () => {
  it("失敗の description は、直前の呼び出しの記録のエラー(HTTP は status=<コード>、それ以外は種別=…)。API のエラー本文は含まない", async () => {
    const w: Warnings = { lines: [] };
    const http = await callReportLlm(llmDeps(failSender(529), w), { noun: "日報", maxTokens: 100 }, "p");
    expect(http.ok).toBe(false);
    if (http.ok) throw new Error("前提: 失敗");
    expect(http.description).toBe("status=529");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.error).toBe("status=529");

    const other = await callReportLlm(llmDeps(failSender(undefined), w), { noun: "日報", maxTokens: 100 }, "p");
    if (other.ok) throw new Error("前提: 失敗");
    expect(other.description).toBe("種別=other");
    expect(JSON.stringify(other)).not.toContain("boom");
  });

  it("設定(D1)を読めなくても、既定のモデルの選択で続ける: LLM は呼ばれ、送るモデルは既定の claude-sonnet-5-5、警告は 1 件(鍵は含まない)", async () => {
    const models: string[] = [];
    const sender: MessageSender = async (params) => {
      models.push(params.model);
      return okSender("本文")(params);
    };
    const w: Warnings = { lines: [] };
    const deps: ReportLlmDeps = {
      ...llmDeps(sender, w),
      loadSettings: async () => {
        throw new Error("D1 が落ちた sk-ant-SECRETKEY123456");
      },
    };
    const done = await callReportLlm(deps, { noun: "日報", maxTokens: 100 }, "p");
    expect(done.ok).toBe(true);
    expect(models).toEqual(["claude-sonnet-5-5"]);
    expect(w.lines).toHaveLength(1);
    expect(w.lines.join("")).not.toContain("SECRETKEY");
  });

  it("成功したら、応答の文章・モデル・呼び出しの記録を返す", async () => {
    const w: Warnings = { lines: [] };
    const done = await callReportLlm(llmDeps(okSender("本文"), w), { noun: "日報", maxTokens: 100 }, "p");
    expect(done.ok).toBe(true);
    if (!done.ok) throw new Error("前提: 成功");
    expect(done.text).toBe("本文");
    expect(done.model).toBe("claude-sonnet-5-5");
    expect(done.calls).toHaveLength(1);
    expect(done.calls[0]!.error).toBeNull();
  });
});

// ---- attemptLlm ----

const OPTIONS = { noun: "日報", key: "20261010", maxTokens: 100, maxAttempts: 2, retryDelayMs: 60_000 } as const;
const jobOf = (extra: Partial<LlmJobFields> = {}): LlmJobFields => ({ nextAt: 0, llmAttempts: 0, llmText: null, llmModel: null, llmGaveUp: false, calls: [], ...extra });

describe("attemptLlm: LLM の 1 回の試行", () => {
  it.each([
    ["諦めたジョブ(llmGaveUp)", jobOf({ llmGaveUp: true, llmAttempts: 2 })],
    ["応答を得ているジョブ(llmText あり)", jobOf({ llmText: "済", llmAttempts: 1 })],
  ])("%s は LLM を呼ばず、ジョブも書かず、retry:false で返す", async (_name, job) => {
    let sends = 0;
    const sender: MessageSender = async (...args) => {
      sends += 1;
      return okSender("x")(...args);
    };
    const puts: LlmJobFields[] = [];
    const result = await attemptLlm(llmDeps(sender, { lines: [] }), OPTIONS, job, () => "p", (j) => void puts.push(j));
    expect(sends).toBe(0);
    expect(puts).toEqual([]);
    expect(result).toEqual({ job, retry: false });
  });

  it("LLM が無い(キー未登録)ときも呼ばず、何も書かない", async () => {
    const puts: LlmJobFields[] = [];
    const deps: ReportLlmDeps = { ...llmDeps(okSender("x"), { lines: [] }), llm: undefined };
    const job = jobOf();
    expect(await attemptLlm(deps, OPTIONS, job, () => "p", (j) => void puts.push(j))).toEqual({ job, retry: false });
    expect(puts).toEqual([]);
  });

  it("成功: 試行を呼ぶ前に永続化し(sender の中で llmAttempts:1・応答なしが見える)、応答を成功の直後にもう一度永続化する", async () => {
    const puts: LlmJobFields[] = [];
    let seenInSender: LlmJobFields | undefined;
    const sender: MessageSender = async (...args) => {
      seenInSender = puts[puts.length - 1];
      return okSender("応答")(...args);
    };
    const result = await attemptLlm(llmDeps(sender, { lines: [] }), OPTIONS, jobOf(), () => "p", (j) => void puts.push(j));
    expect(seenInSender).toMatchObject({ llmAttempts: 1, llmText: null });
    expect(puts).toHaveLength(2);
    expect(puts[1]).toMatchObject({ llmAttempts: 1, llmText: "応答", llmModel: "claude-sonnet-5-5" });
    expect(puts[1]!.calls).toHaveLength(1);
    expect(result.retry).toBe(false);
    expect(result.job).toEqual(puts[1]); // 戻り値のジョブは永続化済みのもの
  });

  it("失敗(上限未満): 待ち(retryDelayMs)を足した次の時刻で再試行(retry:true)。上限に達した失敗は諦め(llmGaveUp)、次の時刻は今(待ちなし)", async () => {
    const puts: LlmJobFields[] = [];
    const w: Warnings = { lines: [] };
    const first = await attemptLlm(llmDeps(failSender(529), w, 5_000), OPTIONS, jobOf(), () => "p", (j) => void puts.push(j));
    expect(first.retry).toBe(true);
    expect(first.job).toMatchObject({ llmAttempts: 1, llmGaveUp: false, nextAt: 5_000 + 60_000, llmText: null });
    expect(first.job.calls).toHaveLength(1);

    const second = await attemptLlm(llmDeps(failSender(529), w, 9_000), OPTIONS, first.job, () => "p", (j) => void puts.push(j));
    expect(second.retry).toBe(false);
    expect(second.job).toMatchObject({ llmAttempts: 2, llmGaveUp: true, nextAt: 9_000 });
    expect(second.job.calls).toHaveLength(2);
    expect(puts[puts.length - 1]).toEqual(second.job);

    // 諦めたジョブは、以後 LLM を呼ばない。
    let sends = 0;
    const counting: MessageSender = async (...args) => {
      sends += 1;
      return okSender("x")(...args);
    };
    const third = await attemptLlm(llmDeps(counting, w, 20_000), OPTIONS, second.job, () => "p", (j) => void puts.push(j));
    expect(sends).toBe(0);
    expect(third).toEqual({ job: second.job, retry: false });
    // 警告は固定の語だけ(API のエラー本文は含まない)。
    expect(w.lines.filter((l) => l.startsWith("日報(20261010): LLM の呼び出しに失敗しました"))).toHaveLength(2);
    expect(w.lines.join("\n")).not.toContain("boom");
  });

  it("プロンプトは試行の永続化の後に作る(buildPrompt が呼ばれた時点で、llmAttempts:1 が書かれている)", async () => {
    const puts: LlmJobFields[] = [];
    let putsAtBuild = -1;
    await attemptLlm(llmDeps(okSender("x"), { lines: [] }), OPTIONS, jobOf(), () => {
      putsAtBuild = puts.length;
      return "p";
    }, (j) => void puts.push(j));
    expect(putsAtBuild).toBe(1);
  });
});

// ---- resolveNarrative ----

describe("resolveNarrative: LLM の応答から本文に載せる文章を決める", () => {
  const NOTES = { noKey: "キーなし", failed: "失敗", unparsed: "読めない" } as const;
  const parse = (text: string): { summary: string } | null => (text.startsWith("{") && text.endsWith("}") ? { summary: `総括:${text.length}` } : null);

  it("4 通り(キー無し・応答無し・読めない応答・読めた応答)の全項目", () => {
    expect(resolveNarrative({ hasLlm: false, llmText: null, parse, notes: NOTES })).toEqual({ narrative: null, narrativeRaw: null, note: "キーなし", summary: null });
    expect(resolveNarrative({ hasLlm: true, llmText: null, parse, notes: NOTES })).toEqual({ narrative: null, narrativeRaw: null, note: "失敗", summary: null });
    expect(resolveNarrative({ hasLlm: true, llmText: "生の文章", parse, notes: NOTES })).toEqual({ narrative: null, narrativeRaw: "生の文章", note: "読めない", summary: "生の文章" });
    expect(resolveNarrative({ hasLlm: true, llmText: "{12}", parse, notes: NOTES })).toEqual({ narrative: { summary: "総括:4" }, narrativeRaw: null, note: null, summary: "総括:4" });
  });

  it("読めない応答の生の文章・総括は、前後の空白を除いてから切る(先頭の空白で字数を食わない)", () => {
    const body = "x".repeat(310);
    const result = resolveNarrative({ hasLlm: true, llmText: `  \n${body}\n  `, parse, notes: NOTES });
    expect(result.summary).toBe(`${"x".repeat(299)}…`);
    expect(result.narrativeRaw).toBe(body); // 生の文章は 20,000 字以内なので切らない。空白だけが除かれる
    // 空白を除いた長さがちょうど上限なら切らない(空白を除かずに数えると上限を超えて切ってしまう)。
    const exact = resolveNarrative({ hasLlm: true, llmText: ` ${"y".repeat(300)} `, parse, notes: NOTES });
    expect(exact.summary).toBe("y".repeat(300));
  });

  it("生の文章は先頭 20,000 字まで(総括は先頭 300 字)。字数は定数を参照せず、直に書く(定数の変異を見逃さない)", () => {
    const long = "z".repeat(20_005);
    const result = resolveNarrative({ hasLlm: true, llmText: long, parse, notes: NOTES });
    expect(result.narrativeRaw).toBe(`${"z".repeat(19_999)}…`);
    expect(result.summary).toBe(`${"z".repeat(299)}…`);
    // 境界: ちょうど 20,000 字は切らない(20,001 字は切る)。
    expect(resolveNarrative({ hasLlm: true, llmText: "w".repeat(20_000), parse, notes: NOTES }).narrativeRaw).toBe("w".repeat(20_000));
    expect(resolveNarrative({ hasLlm: true, llmText: "w".repeat(20_001), parse, notes: NOTES }).narrativeRaw).toBe(`${"w".repeat(19_999)}…`);
  });
});

// ---- ReportJobStore ----

interface TestJob extends StoredJobFields {
  readonly id: string;
}

function memoryJobKv(): JobKv & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string): T | undefined => (data.has(key) ? (structuredClone(data.get(key)) as T) : undefined),
    put: (key, value) => void data.set(key, structuredClone(value)),
    delete: (key) => void data.delete(key),
  };
}

function storeOf(now: { t: number }) {
  const kv = memoryJobKv();
  const alarms: number[] = [];
  const warns: string[] = [];
  const store = new ReportJobStore<TestJob>(
    { kv, now: () => now.t, setAlarm: (at) => void alarms.push(at), onWarn: (m) => void warns.push(m) },
    (j) => j.id,
  );
  const add = (id: string, nextAt: number, status: TestJob["status"] = "running", attempts = 0): void => {
    store.put({ id, mode: "auto", status, attempts, nextAt });
    store.addToIndex(id);
  };
  return { kv, alarms, warns, store, add };
}

describe("ReportJobStore.pickDue: 期限の来たジョブの選択", () => {
  it("nextAt の早いものが先。同じ時刻なら鍵の昇順(索引の並びには依らない)。期限が来ていない・failed のジョブは選ばない", () => {
    const now = { t: 1_000 };
    const { store, add } = storeOf(now);
    add("20261012", 500);
    add("20261010", 500);
    add("20261011", 500);
    add("20261009", 900); // nextAt が遅い
    add("20261008", 100, "failed"); // failed は動かさない
    add("20261007", 1_001); // まだ来ていない
    const picked: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const job = store.pickDue();
      if (job === undefined) break;
      picked.push(job.id);
      store.finish(job.id);
    }
    expect(picked).toEqual(["20261010", "20261011", "20261012", "20261009"]);
    expect(store.pickDue()).toBeUndefined();
  });

  it("nextAt がちょうど今のジョブは選ぶ", () => {
    const now = { t: 1_000 };
    const { store, add } = storeOf(now);
    add("20261010", 1_000);
    expect(store.pickDue()?.id).toBe("20261010");
  });
});

describe("ReportJobStore: 索引", () => {
  it("finish は、そのジョブだけを索引から外す(他のジョブは残る)。最後の1つを外すと索引のキーごと消える", () => {
    const now = { t: 1_000 };
    const { kv, store, add } = storeOf(now);
    add("20261010", 0);
    add("20261011", 0);
    add("20261012", 0);
    store.finish("20261011");
    expect(kv.get<string[]>("jobs")).toEqual(["20261010", "20261012"]);
    expect(store.get("20261011")).toBeUndefined(); // ジョブ本体も消える
    store.finish("20261010");
    store.finish("20261012");
    expect(kv.get("jobs")).toBeUndefined();
    expect(kv.data.size).toBe(0);
  });

  it("addToIndex は重複して足さない", () => {
    const now = { t: 1_000 };
    const { kv, store } = storeOf(now);
    store.addToIndex("20261010");
    store.addToIndex("20261010");
    store.addToIndex("20261011");
    expect(kv.get<string[]>("jobs")).toEqual(["20261010", "20261011"]);
  });
});

describe("ReportJobStore.failStep: 段階の失敗", () => {
  const STEP = { noun: "日報", maxAttempts: 3, retryDelayMs: 60_000 } as const;

  it("上限未満: 試行を 1 数え、次の時刻は今 + 待ち(retryDelayMs)で再試行。索引に残す。警告はこの順で 1 件", () => {
    const now = { t: 10_000 };
    const { kv, store, add, warns } = storeOf(now);
    add("20261010", 0, "running", 0);
    const job = store.get("20261010")!;
    expect(store.failStep(job, "list", new Error("D1 が落ちた sk-ant-SECRETKEY123456"), STEP)).toBe("retry");
    expect(store.get("20261010")).toEqual({ id: "20261010", mode: "auto", status: "running", attempts: 1, nextAt: 10_000 + 60_000 });
    expect(kv.get<string[]>("jobs")).toEqual(["20261010"]);
    expect(warns).toEqual(["日報(20261010): list に失敗しました(試行 1 回): D1 が落ちた sk-ant-***"]);
    expect(warns.join("")).not.toContain("SECRETKEY"); // 鍵は警告に出さない
  });

  it("上限に達した失敗: failed にして索引から外す(次の時刻は変えない)", () => {
    const now = { t: 10_000 };
    const { kv, store, add } = storeOf(now);
    add("20261010", 777, "running", 2);
    expect(store.failStep(store.get("20261010")!, "save", new Error("x"), STEP)).toBe("failed");
    expect(store.get("20261010")).toEqual({ id: "20261010", mode: "auto", status: "failed", attempts: 3, nextAt: 777 });
    expect(kv.get("jobs")).toBeUndefined(); // 索引が空になったらキーごと消える
  });
});

describe("ReportJobStore.rearm: アラーム", () => {
  it("動かせるジョブのうち最も早い時刻に張る(索引の先頭ではなく最小)。failed のジョブは数えない", async () => {
    const now = { t: 1_000 };
    const { store, add, alarms } = storeOf(now);
    add("20261010", 9_000);
    add("20261011", 5_000);
    add("20261012", 7_000);
    add("20261009", 2_000, "failed");
    await store.rearm();
    expect(alarms).toEqual([5_000]);
  });

  it("今より前の時刻にはしない(期限が過ぎているジョブがあれば、アラームは今)", async () => {
    const now = { t: 10_000 };
    const { store, add, alarms } = storeOf(now);
    add("20261010", 3_000);
    add("20261011", 20_000);
    await store.rearm();
    expect(alarms).toEqual([10_000]);
  });

  it("動かせるジョブが無ければ張らない", async () => {
    const now = { t: 1_000 };
    const { store, add, alarms } = storeOf(now);
    await store.rearm();
    add("20261010", 0, "failed");
    await store.rearm();
    expect(alarms).toEqual([]);
  });
});
