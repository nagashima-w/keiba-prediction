/**
 * モデルの自動選択(Issue #157)のテスト。
 *
 * - pickLatestSonnet: Models API の一覧から「最新の Sonnet」を選ぶ純関数。
 *   ID が `claude-sonnet-<major>(-<minor>)?` のものだけに絞り(日付付きスナップショット・preview 等は除外)、
 *   (major, minor) の降順、同順位は created_at の新しい順。数値として比較する(文字列比較にしない)。
 * - createModelSelector: 遅延取得・メモ化(失敗もメモ化・TTLなし)・降格の記憶。
 * - pickLatestOfFamily / createModelSelector の family(Issue #158): Sonnet だけでなく Opus・Haiku の最新も同じ規則で選ぶ。
 * 実 API は呼ばない(lister は注入)。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createModelSelector,
  MODEL_FAMILIES,
  pickLatestOfFamily,
  pickLatestSonnet,
  type ModelFamily,
  type ModelInfoLite,
} from "../../src/analyzer/model-selection.js";

function m(id: string, created = "2026-01-01T00:00:00Z"): ModelInfoLite {
  return { id, created_at: created };
}

describe("pickLatestSonnet(最新の Sonnet の選別)", () => {
  const cases: { name: string; models: ModelInfoLite[]; expected: string | null }[] = [
    {
      name: "(major, minor) の降順で最新を選ぶ",
      models: [m("claude-sonnet-4-6"), m("claude-sonnet-5-5"), m("claude-sonnet-5")],
      expected: "claude-sonnet-5-5",
    },
    {
      name: "minor 省略は minor=0 として扱う(5 < 5-1)",
      models: [m("claude-sonnet-5"), m("claude-sonnet-5-1")],
      expected: "claude-sonnet-5-1",
    },
    {
      name: "major は数値比較(9-9 より 10 が新しい。文字列比較なら '9-9' が勝ってしまう)",
      models: [m("claude-sonnet-9-9"), m("claude-sonnet-10")],
      expected: "claude-sonnet-10",
    },
    {
      name: "minor は数値比較(5-9 より 5-10 が新しい)",
      models: [m("claude-sonnet-5-9"), m("claude-sonnet-5-10")],
      expected: "claude-sonnet-5-10",
    },
    {
      name: "Sonnet 以外(opus・haiku・fable)は無視する",
      models: [m("claude-opus-5-5"), m("claude-haiku-4-5"), m("claude-fable-5-1"), m("claude-sonnet-4-6")],
      expected: "claude-sonnet-4-6",
    },
    {
      name: "日付付きスナップショット(claude-sonnet-4-20250514)は除外する(minor=20250514 として最新扱いされない)",
      models: [m("claude-sonnet-4-20250514"), m("claude-sonnet-4-6")],
      expected: "claude-sonnet-4-6",
    },
    {
      name: "日付付きスナップショット(claude-sonnet-4-5-20250929)は除外する",
      models: [m("claude-sonnet-4-5-20250929"), m("claude-sonnet-4-5")],
      expected: "claude-sonnet-4-5",
    },
    {
      name: "preview・latest などの接尾辞付きは除外する",
      models: [m("claude-sonnet-6-preview"), m("claude-sonnet-5-5-latest"), m("claude-sonnet-5-5")],
      expected: "claude-sonnet-5-5",
    },
    {
      name: "接頭辞違い(anthropic.claude-sonnet-5-5・my-claude-sonnet-9)は除外する",
      models: [m("anthropic.claude-sonnet-5-5"), m("my-claude-sonnet-9"), m("claude-sonnet-4-6")],
      expected: "claude-sonnet-4-6",
    },
    {
      name: "Sonnet が0件なら null",
      models: [m("claude-opus-5-5"), m("claude-haiku-4-5")],
      expected: null,
    },
    {
      name: "一覧が空なら null",
      models: [],
      expected: null,
    },
    {
      name: "同順位(5 と 5-0)は created_at が新しいほうを選ぶ",
      models: [m("claude-sonnet-5", "2026-03-01T00:00:00Z"), m("claude-sonnet-5-0", "2026-09-01T00:00:00Z")],
      expected: "claude-sonnet-5-0",
    },
    {
      name: "同順位(5-0 と 5)は created_at が新しいほうを選ぶ(入力順に依存しない)",
      models: [m("claude-sonnet-5-0", "2026-03-01T00:00:00Z"), m("claude-sonnet-5", "2026-09-01T00:00:00Z")],
      expected: "claude-sonnet-5",
    },
  ];

  it.each(cases)("$name", ({ models, expected }) => {
    expect(pickLatestSonnet(models)).toBe(expected);
    // 入力順を逆にしても結果は変わらない(順序に依存しない)
    expect(pickLatestSonnet([...models].reverse())).toBe(expected);
  });

  it("created_at が解釈できなくても例外を投げず、(major, minor) で決まること", () => {
    const picked = pickLatestSonnet([
      m("claude-sonnet-5-5", "不正な日時"),
      m("claude-sonnet-4-6", "2030-01-01T00:00:00Z"),
    ]);
    expect(picked).toBe("claude-sonnet-5-5");
  });
});

describe("createModelSelector(遅延取得・メモ化・降格)", () => {
  const FIXED = "claude-sonnet-5-5";

  it("resolve を呼ぶまで lister を呼ばないこと(遅延取得)", () => {
    const lister = vi.fn(async () => [m("claude-sonnet-9-9")]);
    createModelSelector({ lister, fixedModel: FIXED });
    expect(lister).not.toHaveBeenCalled();
  });

  it("最新 Sonnet を返し、何度 resolve しても lister は1回だけ(並行呼び出しを含む)", async () => {
    const lister = vi.fn(async () => [m("claude-sonnet-4-6"), m("claude-sonnet-9-9")]);
    const sel = createModelSelector({ lister, fixedModel: FIXED });
    const [a, b] = await Promise.all([sel.resolve(), sel.resolve()]);
    const c = await sel.resolve();
    expect([a, b, c]).toEqual(["claude-sonnet-9-9", "claude-sonnet-9-9", "claude-sonnet-9-9"]);
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it("lister が失敗したら固定モデルを返し、onWarn に1回残し、失敗もメモ化して再取得しないこと", async () => {
    const lister = vi.fn(async (): Promise<ModelInfoLite[]> => {
      throw new Error("一覧取得失敗");
    });
    const onWarn = vi.fn<(msg: string) => void>();
    const sel = createModelSelector({ lister, fixedModel: FIXED, onWarn });
    expect(await sel.resolve()).toBe(FIXED);
    expect(await sel.resolve()).toBe(FIXED);
    expect(lister).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("Sonnet が0件なら固定モデルを返し、onWarn に1回残すこと", async () => {
    const lister = vi.fn(async () => [m("claude-opus-5-5")]);
    const onWarn = vi.fn<(msg: string) => void>();
    const sel = createModelSelector({ lister, fixedModel: FIXED, onWarn });
    expect(await sel.resolve()).toBe(FIXED);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("demote 後は(自動選択に成功していても)固定モデルを返すこと", async () => {
    const lister = vi.fn(async () => [m("claude-sonnet-9-9")]);
    const sel = createModelSelector({ lister, fixedModel: FIXED });
    expect(await sel.resolve()).toBe("claude-sonnet-9-9");
    sel.demote();
    expect(await sel.resolve()).toBe(FIXED);
  });

  it("selector ごとに独立していること(別インスタンスの降格は影響しない)", async () => {
    const lister = async () => [m("claude-sonnet-9-9")];
    const a = createModelSelector({ lister, fixedModel: FIXED });
    const b = createModelSelector({ lister, fixedModel: FIXED });
    a.demote();
    expect(await a.resolve()).toBe(FIXED);
    expect(await b.resolve()).toBe("claude-sonnet-9-9");
  });

  it("固定モデルを fixedModel として公開すること", () => {
    const sel = createModelSelector({ lister: async () => [], fixedModel: FIXED });
    expect(sel.fixedModel).toBe(FIXED);
  });
});

/**
 * Issue #158: family(sonnet・opus・haiku)ごとの最新の選別。
 * 規則は Sonnet と同じ(ID が `claude-<family>-<major>(-<minor>)?` だけ。日付付き・接尾辞付きは除外。(major, minor) の降順→created_at→ID)。
 */
describe("pickLatestOfFamily(family ごとの最新の選別。Issue #158)", () => {
  it("family は sonnet・opus・haiku の3つ(MODEL_FAMILIES)", () => {
    expect([...MODEL_FAMILIES]).toEqual(["sonnet", "opus", "haiku"]);
  });

  // 一覧は3 family が混ざる(実際の Models API の一覧に近い形)。日付付きスナップショット・fable・旧来表記も混ぜる。
  const MIXED: ModelInfoLite[] = [
    m("claude-sonnet-5-5"),
    m("claude-sonnet-4-6"),
    m("claude-sonnet-4-20250514"),
    m("claude-opus-5-5"),
    m("claude-opus-5"),
    m("claude-opus-4-1"),
    m("claude-opus-4-1-20250805"),
    m("claude-haiku-5-5"),
    m("claude-haiku-4-5"),
    m("claude-haiku-4-5-20251001"),
    m("claude-3-5-haiku-20241022"),
    m("claude-fable-5-1"),
  ];

  it.each<[ModelFamily, string]>([
    ["sonnet", "claude-sonnet-5-5"],
    ["opus", "claude-opus-5-5"],
    ["haiku", "claude-haiku-5-5"],
  ])("混在した一覧から %s の最新を選ぶ(他 family・日付付き・旧来表記・fable に引きずられない): %s", (family, expected) => {
    expect(pickLatestOfFamily(MIXED, family)).toBe(expected);
    expect(pickLatestOfFamily([...MIXED].reverse(), family)).toBe(expected);
  });

  it("前提(空振り防止): 3 family の最新はそれぞれ別の ID で、どれも null でない", () => {
    const picked = MODEL_FAMILIES.map((f) => pickLatestOfFamily(MIXED, f));
    expect(picked.every((x) => x !== null)).toBe(true);
    expect(new Set(picked).size).toBe(3);
  });

  const SUFFIXED: { family: ModelFamily; models: ModelInfoLite[]; expected: string | null; name: string }[] = [
    { family: "opus", name: "opus: 日付付き(claude-opus-4-20250514)は minor=20250514 の最新扱いにならない", models: [m("claude-opus-4-20250514"), m("claude-opus-4-1")], expected: "claude-opus-4-1" },
    { family: "haiku", name: "haiku: 日付付き(claude-haiku-4-5-20251001)は除外し、素の claude-haiku-4-5 を選ぶ", models: [m("claude-haiku-4-5-20251001"), m("claude-haiku-4-5")], expected: "claude-haiku-4-5" },
    { family: "opus", name: "opus: preview・latest 付きは除外する", models: [m("claude-opus-6-preview"), m("claude-opus-5-5-latest"), m("claude-opus-5")], expected: "claude-opus-5" },
    { family: "haiku", name: "haiku: major・minor は数値比較(4-9 より 4-10、9-9 より 10)", models: [m("claude-haiku-4-9"), m("claude-haiku-4-10")], expected: "claude-haiku-4-10" },
    { family: "haiku", name: "haiku: major は数値比較", models: [m("claude-haiku-9-9"), m("claude-haiku-10")], expected: "claude-haiku-10" },
    { family: "opus", name: "opus: 接頭辞違い(anthropic.claude-opus-9)は除外する", models: [m("anthropic.claude-opus-9"), m("claude-opus-5")], expected: "claude-opus-5" },
    { family: "opus", name: "opus: 同順位(5 と 5-0)は created_at が新しいほう", models: [m("claude-opus-5", "2026-03-01T00:00:00Z"), m("claude-opus-5-0", "2026-09-01T00:00:00Z")], expected: "claude-opus-5-0" },
    { family: "opus", name: "opus: 該当が無ければ null(他 family だけの一覧)", models: [m("claude-sonnet-5-5"), m("claude-haiku-5-5")], expected: null },
    { family: "haiku", name: "haiku: 一覧が空なら null", models: [], expected: null },
  ];
  it.each(SUFFIXED)("$name", ({ family, models, expected }) => {
    expect(pickLatestOfFamily(models, family)).toBe(expected);
    expect(pickLatestOfFamily([...models].reverse(), family)).toBe(expected);
  });

  it("pickLatestSonnet は pickLatestOfFamily(…, 'sonnet') と同じ結果(後方互換)", () => {
    expect(pickLatestSonnet(MIXED)).toBe(pickLatestOfFamily(MIXED, "sonnet"));
    expect(pickLatestSonnet(MIXED)).toBe("claude-sonnet-5-5");
  });
});

describe("createModelSelector の family(Issue #158)", () => {
  const FIXED = "claude-sonnet-5-5";
  const LIST = [m("claude-sonnet-5-5"), m("claude-opus-5-5"), m("claude-haiku-5-5")];

  it("family 省略は sonnet(従来どおり。exe の挙動は変わらない)", async () => {
    const sel = createModelSelector({ lister: async () => LIST, fixedModel: FIXED });
    expect(await sel.resolve()).toBe("claude-sonnet-5-5");
  });

  it.each<[ModelFamily, string]>([
    ["sonnet", "claude-sonnet-5-5"],
    ["opus", "claude-opus-5-5"],
    ["haiku", "claude-haiku-5-5"],
  ])("family=%s は、その family の最新を返す", async (family, expected) => {
    const sel = createModelSelector({ lister: async () => LIST, fixedModel: FIXED, family });
    expect(await sel.resolve()).toBe(expected);
  });

  it("opus の降格: demote 後は(opus を選べていても)固定モデル(Sonnet)を返す。fixedModel は family によらず固定モデル", async () => {
    const sel = createModelSelector({ lister: async () => LIST, fixedModel: FIXED, family: "opus" });
    expect(sel.fixedModel).toBe(FIXED);
    expect(await sel.resolve()).toBe("claude-opus-5-5");
    sel.demote();
    expect(await sel.resolve()).toBe(FIXED);
  });

  it("その family が一覧に無ければ固定モデルを返し、警告に family 名(Opus)を入れる。Sonnet の警告文は従来のまま", async () => {
    const onWarnOpus = vi.fn<(msg: string) => void>();
    const opus = createModelSelector({ lister: async () => [m("claude-sonnet-5-5")], fixedModel: FIXED, family: "opus", onWarn: onWarnOpus });
    expect(await opus.resolve()).toBe(FIXED);
    expect(onWarnOpus).toHaveBeenCalledTimes(1);
    expect(onWarnOpus.mock.calls[0]![0]).toContain("Opus");
    expect(onWarnOpus.mock.calls[0]![0]).toContain(FIXED);

    const onWarnSonnet = vi.fn<(msg: string) => void>();
    const sonnet = createModelSelector({ lister: async () => [m("claude-opus-5-5")], fixedModel: FIXED, onWarn: onWarnSonnet });
    expect(await sonnet.resolve()).toBe(FIXED);
    expect(onWarnSonnet).toHaveBeenCalledWith(`利用可能なモデルに Sonnet が見つからないため、固定モデル(${FIXED})を使います`);
  });

  it("family ごとの selector は独立(opus の降格は haiku・sonnet に影響しない)。lister を共有しても各 selector は自分の family を選ぶ", async () => {
    const lister = vi.fn(async () => LIST);
    const opus = createModelSelector({ lister, fixedModel: FIXED, family: "opus" });
    const haiku = createModelSelector({ lister, fixedModel: FIXED, family: "haiku" });
    expect(await opus.resolve()).toBe("claude-opus-5-5");
    opus.demote();
    expect(await opus.resolve()).toBe(FIXED);
    expect(await haiku.resolve()).toBe("claude-haiku-5-5");
  });
});
