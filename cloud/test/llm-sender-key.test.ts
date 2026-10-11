import { describe, expect, it, vi } from "vitest";

// `@keiba/core/llm` の sender・lister の作成関数を、本物を呼びつつ引数を記録する形に差し替える(SDK に渡るオプションそのものを見るため)。実 API には出ない(呼び出さない)。
const created = vi.hoisted(() => ({ sender: [] as { apiKey?: string }[], lister: [] as { apiKey?: string }[] }));
vi.mock("@keiba/core/llm", async (importOriginal) => {
  const original = await importOriginal<typeof import("@keiba/core/llm")>();
  return {
    ...original,
    createSdkMessageSender: (options: { apiKey?: string }) => {
      created.sender.push(options);
      return original.createSdkMessageSender(options);
    },
    createSdkModelLister: (options: { apiKey?: string }) => {
      created.lister.push(options);
      return original.createSdkModelLister(options);
    },
  };
});

import { createCloudLlm, createCloudLlmSender, createCloudModelLister } from "../src/llm-sender";

/**
 * Issue #194(メタレビュー R5): SDK に**渡すキーそのもの**が、前後の空白(改行を含む)を除いたものであること。
 * 送られるヘッダは、SDK の `Headers` が空白を正規化するので trim の有無に依らず同じ(`llm-sender.test.ts` の注記)。そのため、ここでは SDK への引数を直接見る。
 */
describe("SDK に渡す API キーは trim 済み(Issue #194 R5)", () => {
  const BARE = "sk-ant-fake-test-key-not-real";

  it.each([[`${BARE}\n`], [`  ${BARE}  `], [`\t${BARE}\r\n`], [BARE]])("createCloudLlmSender・createCloudModelLister: キーが %j でも、SDK への apiKey は空白のないキー", (raw) => {
    created.sender.length = 0;
    created.lister.length = 0;
    createCloudLlmSender(raw);
    createCloudModelLister(raw);
    expect(created.sender.map((o) => o.apiKey)).toEqual([BARE]);
    expect(created.lister.map((o) => o.apiKey)).toEqual([BARE]);
  });

  it("createCloudLlm(RaceDay が使う入口): sender・lister の両方に、空白のないキーを渡す。空白だけのキーは作らない", () => {
    created.sender.length = 0;
    created.lister.length = 0;
    expect(createCloudLlm(`\n${BARE}\n`)).toBeDefined();
    expect(created.sender.map((o) => o.apiKey)).toEqual([BARE]);
    expect(created.lister.map((o) => o.apiKey)).toEqual([BARE]);
    created.sender.length = 0;
    expect(createCloudLlm(" \n ")).toBeUndefined();
    expect(created.sender).toHaveLength(0);
  });
});
