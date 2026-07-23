import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";
import {
  AnalysisStore,
  CLIP_VARIANTS,
  parseKaisaiDate,
  parseRaceId,
  resolveClipVariant,
  type AnthropicMessageResponse,
  type BuildPromptInput,
  type FetchLike,
  type FetchResponse,
  type MessageSender,
} from "@keiba/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPipelineDeps,
  shouldUseLlm,
  type PipelineResources,
} from "../src/main/pipeline-deps.js";

describe("shouldUseLlm(APIキー有無の判定)", () => {
  it("APIキーが未設定・空白のみなら false", () => {
    expect(shouldUseLlm(undefined)).toBe(false);
    expect(shouldUseLlm("")).toBe(false);
    expect(shouldUseLlm("   ")).toBe(false);
  });

  it("APIキーがあれば true", () => {
    expect(shouldUseLlm("sk-ant-xxx")).toBe(true);
  });
});

describe("createPipelineDeps(本番依存の配線)", () => {
  const resources: PipelineResources[] = [];
  afterEach(() => {
    for (const r of resources.splice(0)) {
      r.close();
    }
    // vi.spyOn(AnalysisStore.prototype, ...) 等のスパイをテストごとに必ず復元する
    // (code-reviewer指摘対応: テスト本体末尾の mockRestore() はアサーション失敗時に
    // 到達せず、スパイが後続テストへ漏れ残る恐れがあったため afterEach に一本化する)。
    vi.restoreAllMocks();
  });

  it("APIキー未設定なら analyze=null・スキップ理由付きで組み立てる", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(r.deps.analyze).toBeNull();
    expect(r.deps.llmSkipReason).toContain("APIキー");
    expect(typeof r.deps.saveAnalysis).toBe("function");
    expect(typeof r.deps.scrape).toBe("function");
    expect(typeof r.listRaces).toBe("function");
  });

  it("clipVariant未指定なら deps.clipVariant は対照('default')になること(タスクD-2: 配線疎通)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(r.deps.clipVariant).toBe("default");
    // 実際に parseAnalyzerResponse へ渡る maxAdjust(analyzeRace の deps.maxAdjust)は、
    // この deps.clipVariant を resolveClipVariant で解決した値と単一ソースで一致する
    // (pipeline-deps.ts が config.clipVariant を1回だけ解決し、analyzeRace束縛とこのフィールドの
    // 両方に同じ変数を使っているため。build-prompt.test.ts・clip-variants.test.ts の
    // 「文面==クリップ幅」一致テストと合わせて全体の単一ソース性を保証する)。
    expect(resolveClipVariant(r.deps.clipVariant).maxAdjust).toBe(CLIP_VARIANTS.default.maxAdjust);
  });

  it("clipVariant='wide15' を渡すと deps.clipVariant='wide15'(maxAdjust=0.15)が届くこと(タスクD-2: 配線疎通)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:", clipVariant: "wide15" });
    resources.push(r);
    expect(r.deps.clipVariant).toBe("wide15");
    expect(resolveClipVariant(r.deps.clipVariant).maxAdjust).toBe(0.15);
  });

  it("clipVariantに不正な値を渡しても対照('default')へフォールバックすること(タスクD-2: 不正値フォールバック)", () => {
    const r = createPipelineDeps({
      dbPath: ":memory:",
      clipVariant: "bogus" as unknown as Parameters<typeof createPipelineDeps>[0]["clipVariant"],
    });
    resources.push(r);
    expect(r.deps.clipVariant).toBe("default");
  });

  describe("clipVariant→maxAdjustの配線が実際にparseAnalyzerResponseへ届くこと(タスクD-2: code-reviewer指摘対応の回帰テスト)", () => {
    /**
     * 常に prior+0.20 相当の place_prob(0.60。prior=0.40固定)を返す固定LLM応答。
     * config.llmSender(テスト専用の差し替え口。AnthropicLlmClient の既存 deps.sender 注入口を
     * pipeline-deps.ts が通すだけ)経由で、実ネットワーク・実API課金なしに deps.analyze を
     * 実際に呼び出して検証できる。◎〇▲△の頭数制約(parseAnalyzerResponseの予想印検証)を
     * 満たす埋め合わせ馬(馬番2〜4)も含める。
     */
    const fixedSender: MessageSender = async (): Promise<AnthropicMessageResponse> => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            horses: [
              { number: 1, place_prob: 0.6, reason: "テスト応答", mark: "◎" },
              { number: 2, place_prob: 0.3, reason: "x", mark: "〇" },
              { number: 3, place_prob: 0.3, reason: "x", mark: "▲" },
              { number: 4, place_prob: 0.3, reason: "x", mark: "△" },
            ],
          }),
        },
      ],
    });

    /** 馬番1(prior=0.40)が対象。2〜4は印の頭数制約を満たすための埋め合わせ。 */
    function samplePromptInput(): BuildPromptInput {
      return {
        race: { courseType: "芝", distance: 1600 },
        horses: [
          { umaban: 1, horseName: "対象馬", prior: 0.4, runs: [] },
          { umaban: 2, horseName: "馬2", prior: 0.3, runs: [] },
          { umaban: 3, horseName: "馬3", prior: 0.3, runs: [] },
          { umaban: 4, horseName: "馬4", prior: 0.3, runs: [] },
        ],
      };
    }

    it("clipVariant='wide15': prior+0.20の応答が実際にprior+0.15(0.55)へクリップされること", async () => {
      const r = createPipelineDeps({
        dbPath: ":memory:",
        apiKey: "sk-ant-fake-test-key-not-real",
        clipVariant: "wide15",
        llmSender: fixedSender,
      });
      resources.push(r);
      const result = await r.deps.analyze!(samplePromptInput());
      const h1 = result.horses.find((h) => h.umaban === 1)!;
      expect(h1.clipped).toBe(true);
      expect(h1.adjustedProb).toBeCloseTo(0.4 + CLIP_VARIANTS.wide15.maxAdjust, 9); // 0.55
    });

    it("clipVariant既定(default): 同じprior+0.20の応答がprior+0.10(0.50)へクリップされること(wide15との差分確認)", async () => {
      const r = createPipelineDeps({
        dbPath: ":memory:",
        apiKey: "sk-ant-fake-test-key-not-real",
        llmSender: fixedSender,
      });
      resources.push(r);
      const result = await r.deps.analyze!(samplePromptInput());
      const h1 = result.horses.find((h) => h.umaban === 1)!;
      expect(h1.clipped).toBe(true);
      expect(h1.adjustedProb).toBeCloseTo(0.4 + CLIP_VARIANTS.default.maxAdjust, 9); // 0.50
    });
  });

  it("onFallback 未指定なら deps.onFallback は undefined であること(論点E)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(r.deps.onFallback).toBeUndefined();
  });

  it("onFallback を渡すと deps.onFallback から診断メッセージ・raceId・stopReason で呼ばれること(論点E: ログ配線用)", () => {
    const onFallback = vi.fn();
    const r = createPipelineDeps({ dbPath: ":memory:", onFallback });
    resources.push(r);
    r.deps.onFallback?.({
      raceId: parseRaceId("202605020811"),
      stopReason: "max_tokens",
      diagnosticMessage: "テスト診断メッセージ",
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("テスト診断メッセージ", {
      raceId: "202605020811",
      stopReason: "max_tokens",
    });
  });

  describe("importResult の saveResult DI 配線(タスク#27-A2: 配線落ち検出)", () => {
    /**
     * 型だけでは検出できない配線落ち(DIラムダが引数を静かに落としても型検査は通る)を防ぐための
     * 結合寄りテスト。AnalysisStore.prototype.saveResult をスパイに差し替え、
     * createPipelineDeps が組み立てる importResult(内部で result-import.ts の
     * importRaceResult → deps.saveResult → store.saveResult と繋がる)を実際に実行し、
     * パース結果の courseType(面)がスパイの第3引数まで実際に届くことを確認する。
     * DIラムダが `(rid, entries) => store.saveResult(rid, entries)` のように引数を落としても
     * TypeScript 上は合法(コールバック型は少ない引数の実装を許容する)なため、この検出には
     * 実行時アサーションが必須(型検査だけでは再発を防げない)。
     */
    it("合成HTML(芝1200m見出し+最小結果行)を取り込むと、courseType='芝'がstore.saveResultの第3引数まで届くこと", async () => {
      const saveResultSpy = vi.spyOn(AnalysisStore.prototype, "saveResult");

      // 実サイトアクセスなしの合成HTML。.RaceData01(芝1200m)+ #All_Result_Table の最小行。
      const html = `<html><body>
        <div class="RaceData01">15:35発走 /<span> 芝1200m</span> (右A) / 天候:晴 / 馬場:良</div>
        <table id="All_Result_Table"><tbody>
          <tr class="HorseList">
            <td class="Result_Num"><div class="Rank">1</div></td>
            <td class="Num Waku1"><div>1</div></td>
            <td class="Num Txt_C"><div>1</div></td>
            <td class="Horse_Info">
              <span class="Horse_Name">
                <a href="https://db.netkeiba.com/horse/2022101678" title="テスト馬">
                  <span class="HorseNameSpan">テスト馬</span>
                </a>
              </span>
            </td>
          </tr>
        </tbody></table>
      </body></html>`;
      const response: FetchResponse = {
        status: 200,
        ok: true,
        headers: {
          get: (name: string): string | null =>
            name.toLowerCase() === "content-type"
              ? "text/html; charset=utf-8"
              : null,
        },
        arrayBuffer: async (): Promise<ArrayBuffer> =>
          new TextEncoder().encode(html).buffer,
      };
      const fetch = vi.fn<FetchLike>(async () => response);

      const r = createPipelineDeps({ dbPath: ":memory:", fetch });
      resources.push(r);

      const outcome = await r.importResult(parseRaceId("202602010607"));

      expect(outcome.status).toBe("imported");
      expect(saveResultSpy).toHaveBeenCalledTimes(1);
      const [, , courseType] = saveResultSpy.mock.calls[0]!;
      expect(courseType).toBe("芝");
      // スパイの復元は afterEach の vi.restoreAllMocks() に一本化する
      // (このアサーションが失敗しても復元が漏れないようにするため)。
    });
  });

  describe("deps.getRaceResultDetail の配線(タスク#27-C: 当日傾向をプロンプトに反映する配線)", () => {
    // importResult の saveResult DI 配線テストと同じ合成HTML(芝1200m見出し+最小結果行。実サイト非アクセス)。
    const html = `<html><body>
        <div class="RaceData01">15:35発走 /<span> 芝1200m</span> (右A) / 天候:晴 / 馬場:良</div>
        <table id="All_Result_Table"><tbody>
          <tr class="HorseList">
            <td class="Result_Num"><div class="Rank">1</div></td>
            <td class="Num Waku1"><div>1</div></td>
            <td class="Num Txt_C"><div>1</div></td>
            <td class="Horse_Info">
              <span class="Horse_Name">
                <a href="https://db.netkeiba.com/horse/2022101678" title="テスト馬">
                  <span class="HorseNameSpan">テスト馬</span>
                </a>
              </span>
            </td>
          </tr>
        </tbody></table>
      </body></html>`;

    it("importResultで取り込んだレースの結果詳細(面・着順)をgetRaceResultDetailが返すこと", async () => {
      const response: FetchResponse = {
        status: 200,
        ok: true,
        headers: {
          get: (name: string): string | null =>
            name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null,
        },
        arrayBuffer: async (): Promise<ArrayBuffer> => new TextEncoder().encode(html).buffer,
      };
      const fetch = vi.fn<FetchLike>(async () => response);
      const r = createPipelineDeps({ dbPath: ":memory:", fetch });
      resources.push(r);

      await r.importResult(parseRaceId("202602010607"));

      expect(typeof r.deps.getRaceResultDetail).toBe("function");
      const detail = r.deps.getRaceResultDetail!(parseRaceId("202602010607"));
      expect(detail).toBeDefined();
      expect(detail!.courseType).toBe("芝");
      expect(detail!.horses).toHaveLength(1);
      expect(detail!.horses[0]).toMatchObject({ umaban: 1, finishPosition: 1 });
    });

    it("未取込のレースIDにはundefinedを返すこと", () => {
      const r = createPipelineDeps({ dbPath: ":memory:" });
      resources.push(r);
      expect(r.deps.getRaceResultDetail!(parseRaceId("202605020811"))).toBeUndefined();
    });
  });

  it("getVerifyReportByPromptVersion が組み立てられ、未分析なら空配列を返すこと(Task#27)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getVerifyReportByPromptVersion).toBe("function");
    expect(r.getVerifyReportByPromptVersion()).toEqual([]);
  });

  it("deleteUnknownPromptVersionAnalyses が組み立てられ、分析が無ければ削除0件を返すこと(Task#33)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.deleteUnknownPromptVersionAnalyses).toBe("function");
    expect(r.deleteUnknownPromptVersionAnalyses()).toEqual({ deletedCount: 0 });
  });

  it("deleteUnknownPromptVersionAnalyses が版不明の分析だけをAnalysisStoreから削除し、版ありは残すこと(Task#33)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    r.deps.saveAnalysis({
      raceId: "版不明レース",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
    });
    r.deps.saveAnalysis({
      raceId: "版ありレース",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
      promptVersion: "2026-07-14.1",
    });

    const result = r.deleteUnknownPromptVersionAnalyses();

    expect(result).toEqual({ deletedCount: 1 });
    expect(r.getVerifyReportByPromptVersion()).toHaveLength(1);
    expect(r.getVerifyReportByPromptVersion()[0]!.promptVersion).toBe("2026-07-14.1");
  });

  it("getRaceLedger が組み立てられ、未分析なら空配列を返すこと(検証画面UI統合: 旧listAnalysisHistory+getRaceBreakdownの置換)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getRaceLedger).toBe("function");
    expect(r.getRaceLedger()).toEqual([]);
  });

  it("getRaceLedger は結果未取込の分析も対象に含めること(旧getRaceBreakdownとの違い。母集団は分析済みの全レース)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    r.deps.saveAnalysis({
      raceId: "202605020811", // 場コード05 → 東京、末尾2桁11 → 11R。
      analyzedAt: "2026-07-08T10:00:00.000Z",
      kaisaiDate: "20260708",
      horses: [
        {
          umaban: 1,
          prior: 0.5,
          adjustedProb: 0.5,
          placeOddsMin: 2.0,
          ev: 1.0,
          isPositive: true,
          contributions: null,
          mark: null,
        },
      ],
    });
    // 結果はまだ未取込だが、レース一覧統合の母集団には含まれ、hasResult=falseで返ること。
    const [entry] = r.getRaceLedger();
    expect(entry).toBeDefined();
    expect(entry!.raceId).toBe("202605020811");
    expect(entry!.venueName).toBe("東京");
    expect(entry!.raceNumber).toBe(11);
    expect(entry!.hasResult).toBe(false);
    expect(entry!.hasPayout).toBe(false);
  });

  it("getVerifyReport が組み立てられ、未分析なら includedAnalysisCount=0 を返すこと", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.getVerifyReport).toBe("function");
    expect(r.getVerifyReport().includedAnalysisCount).toBe(0);
  });

  it("getVerifyReport は venueKind 引数を computeVerifyReport へそのまま伝え、開催区分で絞り込むこと(Task#32)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    // 中央(場コード05)の分析を1件、結果未取込のまま保存する。
    r.deps.saveAnalysis({
      raceId: "202605020811",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
    });

    // venueKind未指定("all"相当)・central はこの分析を対象に含める(結果未取込のため除外件数として)。
    expect(r.getVerifyReport().excludedAnalysisCount).toBe(1);
    expect(r.getVerifyReport("central").excludedAnalysisCount).toBe(1);
    // nar で絞り込むと、この中央分析はそもそも母集団に入らない(除外件数にも計上されない)。
    expect(r.getVerifyReport("nar").excludedAnalysisCount).toBe(0);
    expect(r.getVerifyReport("nar").includedAnalysisCount).toBe(0);
  });

  it("listUnimportedRaceIds が組み立てられ、未分析なら空配列を返すこと(Task#31)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.listUnimportedRaceIds).toBe("function");
    expect(r.listUnimportedRaceIds()).toEqual([]);
  });

  it("listUnimportedRaceIds が分析済みだが結果未取込のレースIDを返すこと(Task#31)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    r.deps.saveAnalysis({
      raceId: "202605020811",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
    });
    expect(r.listUnimportedRaceIds()).toEqual(["202605020811"]);
  });

  it("listAnalyzedRaceIdsByPromptVersion が組み立てられ、該当なしなら空配列を返すこと(タスクB2b-1)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(typeof r.listAnalyzedRaceIdsByPromptVersion).toBe("function");
    expect(r.listAnalyzedRaceIdsByPromptVersion("v1")).toEqual([]);
  });

  it("listAnalyzedRaceIdsByPromptVersion が指定版で分析済みのレースIDを返すこと(タスクB2b-1)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    r.deps.saveAnalysis({
      raceId: "202605020811",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
      promptVersion: "v1",
    });
    r.deps.saveAnalysis({
      raceId: "202605020812",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [],
      promptVersion: "v2",
    });
    expect(r.listAnalyzedRaceIdsByPromptVersion("v1")).toEqual(["202605020811"]);
  });

  it("APIキーがあれば analyze は関数として組み立てられる", () => {
    const r = createPipelineDeps({ dbPath: ":memory:", apiKey: "sk-ant-xxx" });
    resources.push(r);
    expect(typeof r.deps.analyze).toBe("function");
  });

  it("scorerConfig / evConfig を渡すと deps にそのまま反映される(設定の適用)", () => {
    const scorerConfig = {
      ...DEFAULT_SCORER_CONFIG,
      weights: { ...DEFAULT_SCORER_CONFIG.weights, trackCondition: 0.5 },
    };
    const evConfig = { threshold: 1.4 };
    const r = createPipelineDeps({
      dbPath: ":memory:",
      scorerConfig,
      evConfig,
    });
    resources.push(r);
    expect(r.deps.scorerConfig).toBe(scorerConfig);
    expect(r.deps.evConfig).toBe(evConfig);
  });

  it("additionalInstruction を渡すと deps にそのまま反映される(設定の適用、Task#28)", () => {
    const r = createPipelineDeps({
      dbPath: ":memory:",
      additionalInstruction: "人気薄の複勝率は慎重に見積もること",
    });
    resources.push(r);
    expect(r.deps.additionalInstruction).toBe(
      "人気薄の複勝率は慎重に見積もること",
    );
  });

  it("additionalInstruction未指定ならdeps.additionalInstructionはundefinedのまま(Task#28)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    resources.push(r);
    expect(r.deps.additionalInstruction).toBeUndefined();
  });

  it("config.fetch を渡すと、実HTTP取得(undici既定)ではなく注入した fetch が使われる", async () => {
    // 空HTMLを返す euc-jp レスポンス。parseRaceList は対象要素が無ければ空配列を返す。
    const emptyResponse: FetchResponse = {
      status: 200,
      ok: true,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-type"
            ? "text/html; charset=euc-jp"
            : null,
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
    const fetch = vi.fn<FetchLike>(async () => emptyResponse);

    const r = createPipelineDeps({ dbPath: ":memory:", fetch });
    resources.push(r);

    const entries = await r.listRaces(parseKaisaiDate("20260101"));

    // 注入した fetch がレース一覧サブHTMLの URL で呼ばれ、undici 既定経路を通らないこと。
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain("race_list_sub.html");
    expect(entries).toEqual([]);
  });

  it("listNarRaces は地方(nar.netkeiba.com)のURLで注入fetchを呼ぶこと", async () => {
    const emptyResponse: FetchResponse = {
      status: 200,
      ok: true,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-type"
            ? "text/html; charset=euc-jp"
            : null,
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
    const fetch = vi.fn<FetchLike>(async () => emptyResponse);

    const r = createPipelineDeps({ dbPath: ":memory:", fetch });
    resources.push(r);

    expect(typeof r.listNarRaces).toBe("function");
    const entries = await r.listNarRaces(parseKaisaiDate("20260101"));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain("nar.netkeiba.com");
    expect(fetch.mock.calls[0]![0]).toContain("race_list_sub.html");
    expect(entries).toEqual([]);
  });

  it("config.onWarn を渡すと、HttpClientのサポート外charset警告がconsole.warnではなくonWarnへ届くこと(要修正4: coreはelectronに依存できないため注入経路を組み立てる)", async () => {
    const shiftJisResponse: FetchResponse = {
      status: 200,
      ok: true,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-type"
            ? "text/html; charset=shift_jis"
            : null,
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
    const fetch = vi.fn<FetchLike>(async () => shiftJisResponse);
    const onWarn = vi.fn();

    const r = createPipelineDeps({ dbPath: ":memory:", fetch, onWarn });
    resources.push(r);

    await r.listRaces(parseKaisaiDate("20260101"));

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain("shift_jis");
  });
});
