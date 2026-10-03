/**
 * モデルの自動選択(Issue #157)のテスト。
 *
 * - pickLatestSonnet: Models API の一覧から「最新の Sonnet」を選ぶ純関数。
 *   ID が `claude-sonnet-<major>(-<minor>)?` のものだけに絞り(日付付きスナップショット・preview 等は除外)、
 *   (major, minor) の降順、同順位は created_at の新しい順。数値として比較する(文字列比較にしない)。
 * - createModelSelector: 遅延取得・メモ化(失敗もメモ化・TTLなし)・降格の記憶。
 * 実 API は呼ばない(lister は注入)。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createModelSelector,
  pickLatestSonnet,
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
