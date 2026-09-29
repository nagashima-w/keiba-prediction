import { describe, expect, it } from "vitest";

import {
  ALLOCATION_BET_TYPE_LABELS,
  BASE_SCORE_WEIGHT_KEYS,
  BASE_SCORE_WEIGHT_LABELS,
  BET_ALLOCATION_LABELS,
  BIAS_WEIGHT_KEYS,
  BIAS_WEIGHT_LABELS,
  INCLUDE_COMBO_ODDS_BATCH_NOTE,
  INCLUDE_COMBO_ODDS_LABELS,
  isValidBankroll,
  isValidKellyFraction,
  isValidPerRaceCap,
  isValidThreshold,
  isValidWebhookUrl,
  isValidWeight,
} from "../src/shared/settings.js";

describe("設定フォームの入力検証(純関数)", () => {
  describe("isValidThreshold(EV閾値 > 0)", () => {
    it("正の数は妥当", () => {
      expect(isValidThreshold("1.0")).toBe(true);
      expect(isValidThreshold("0.5")).toBe(true);
      expect(isValidThreshold("2")).toBe(true);
    });

    it("0・負数・空・非数値は不正", () => {
      expect(isValidThreshold("0")).toBe(false);
      expect(isValidThreshold("-1")).toBe(false);
      expect(isValidThreshold("")).toBe(false);
      expect(isValidThreshold("  ")).toBe(false);
      expect(isValidThreshold("abc")).toBe(false);
    });
  });

  describe("isValidWeight(重み >= 0)", () => {
    it("0以上の数は妥当", () => {
      expect(isValidWeight("0")).toBe(true);
      expect(isValidWeight("1.5")).toBe(true);
      expect(isValidWeight("0.2")).toBe(true);
    });

    it("負数・空・非数値は不正", () => {
      expect(isValidWeight("-0.1")).toBe(false);
      expect(isValidWeight("")).toBe(false);
      expect(isValidWeight("x")).toBe(false);
    });
  });

  describe("isValidWebhookUrl(URL形式・任意)", () => {
    it("空文字は許容(未設定)", () => {
      expect(isValidWebhookUrl("")).toBe(true);
      expect(isValidWebhookUrl("   ")).toBe(true);
    });

    it("http/https のURLは妥当", () => {
      expect(
        isValidWebhookUrl("https://discord.com/api/webhooks/123/abc"),
      ).toBe(true);
      expect(isValidWebhookUrl("http://example.com/x")).toBe(true);
    });

    it("URL形式でない・http以外は不正", () => {
      expect(isValidWebhookUrl("notaurl")).toBe(false);
      expect(isValidWebhookUrl("ftp://example.com")).toBe(false);
      expect(isValidWebhookUrl("discord.com/webhooks")).toBe(false);
    });
  });

  describe("isValidBankroll(総資金: 0〜100,000,000の整数。機能C-2)", () => {
    it("0(未設定を表す既定値)・正の整数・上限ちょうどは妥当", () => {
      expect(isValidBankroll("0")).toBe(true);
      expect(isValidBankroll("100000")).toBe(true);
      expect(isValidBankroll("100000000")).toBe(true);
    });

    it("負値・非整数・上限超過・空・非数値は不正", () => {
      expect(isValidBankroll("-1")).toBe(false);
      expect(isValidBankroll("1.5")).toBe(false);
      expect(isValidBankroll("100000001")).toBe(false);
      expect(isValidBankroll("")).toBe(false);
      expect(isValidBankroll("abc")).toBe(false);
      expect(isValidBankroll("NaN")).toBe(false);
      expect(isValidBankroll("Infinity")).toBe(false);
    });
  });

  describe("isValidPerRaceCap(1レースの上限: 0〜10,000,000の整数。機能C-2)", () => {
    it("0(未設定を表す既定値)・正の整数・上限ちょうどは妥当", () => {
      expect(isValidPerRaceCap("0")).toBe(true);
      expect(isValidPerRaceCap("10000")).toBe(true);
      expect(isValidPerRaceCap("10000000")).toBe(true);
    });

    it("負値・非整数・上限超過・空・非数値は不正", () => {
      expect(isValidPerRaceCap("-1")).toBe(false);
      expect(isValidPerRaceCap("99.9")).toBe(false);
      expect(isValidPerRaceCap("10000001")).toBe(false);
      expect(isValidPerRaceCap("")).toBe(false);
      expect(isValidPerRaceCap("x")).toBe(false);
    });
  });

  describe("isValidKellyFraction(ケリー係数: 0.05〜1。機能C-2・UIからλ=0を到達不能にする)", () => {
    it("0.05(下限)・0.5・1(上限)は妥当", () => {
      expect(isValidKellyFraction("0.05")).toBe(true);
      expect(isValidKellyFraction("0.5")).toBe(true);
      expect(isValidKellyFraction("1")).toBe(true);
    });

    it("0(下限未満)・1.0000001(上限超過)・負値・空・非数値は不正", () => {
      expect(isValidKellyFraction("0")).toBe(false);
      expect(isValidKellyFraction("0.049")).toBe(false);
      expect(isValidKellyFraction("1.0000001")).toBe(false);
      expect(isValidKellyFraction("-0.1")).toBe(false);
      expect(isValidKellyFraction("")).toBe(false);
      expect(isValidKellyFraction("abc")).toBe(false);
    });
  });

  describe("BET_ALLOCATION_LABELS(機能C-2ラベル文字列の集約。1箇所定義)", () => {
    it("総資金・1レース上限・ケリー係数のラベルが定義されていること", () => {
      expect(BET_ALLOCATION_LABELS.bankroll).toBeTruthy();
      expect(BET_ALLOCATION_LABELS.bankrollHelp).toBeTruthy();
      expect(BET_ALLOCATION_LABELS.perRaceCap).toBeTruthy();
      expect(BET_ALLOCATION_LABELS.kellyFraction).toBeTruthy();
      // 総資金の補助文は「1レースで使う金額ではない」ことを明示する(仕様の必須要件)。
      expect(BET_ALLOCATION_LABELS.bankrollHelp).toContain("1レースで使う金額ではありません");
    });
  });

  describe("重みキーの定義", () => {
    it("バイアス7種・基礎6種のキーが揃っている(仕様の重み項目)", () => {
      expect(BIAS_WEIGHT_KEYS).toHaveLength(7);
      expect(BASE_SCORE_WEIGHT_KEYS).toHaveLength(6);
      // すべてのキーに日本語ラベルが対応する。
      for (const key of BIAS_WEIGHT_KEYS) {
        expect(BIAS_WEIGHT_LABELS[key]).toBeTruthy();
      }
      for (const key of BASE_SCORE_WEIGHT_KEYS) {
        expect(BASE_SCORE_WEIGHT_LABELS[key]).toBeTruthy();
      }
    });
  });

  describe("INCLUDE_COMBO_ODDS_LABELS(組合せオッズ取得設定の文言。機能D-2c第3段・Issue #28)", () => {
    it("チェックボックスのラベルが空でない", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.checkbox).toBeTruthy();
    });

    // 【機能D-2c第4段・AC19で改訂】旧版(第3段)は「配分提案には一切使わない(記録のみ)」と
    // 断定していたが、第4段で実際に使うようになったため、この断定はもはや事実ではない。
    // 何を保証していたか(新旧対応表):
    //   旧: 「ONにしても配分は絶対に変わらない」という断定文言を保証 → 事実と食い違うため削除
    //   新: 「配分に使うかどうかは別設定(ワイド/三連複を配分に使う)に従う」という条件付きの
    //       依存関係の明記を保証(AC24必須要件1と対になる。INCLUDE_COMBO_ODDS_LABELS.helpの
    //       JSDocも参照)。「記録のみ」という断定は含まれないことも合わせて固定する
    //       (古い断定文言が再混入する退行を検知するため)。
    it("補助文が『配分に使うかどうかは別設定に従う』という依存関係を明示し、『記録のみ』という断定を含まないこと(AC19・AC24)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("配分に使う");
      expect(INCLUDE_COMBO_ODDS_LABELS.help).not.toContain("記録のみ");
      expect(INCLUDE_COMBO_ODDS_LABELS.help).not.toContain("配分提案には使いません");
    });

    // Issue #117(AC-9): v1.9.9(#116)からincludeComboOddsは馬連オッズも取得している
    // (scrape-race.tsがワイド・3連複の後に馬連を1リクエスト追加で取得する)。
    // 「ワイド・三連複のオッズも取得する」という2券種だけの文言は事実と食い違う。
    it("チェックボックス・補助文がどちらも馬連(quinella)の取得に言及すること(Issue #117。v1.9.9から馬連も取得しているため)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.checkbox).toContain("馬連");
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("馬連");
    });

    /**
     * Issue #122(#24-E2・オーケストレーター指定2026-09-25): #116で「取得しているのに
     * チェックボックスのラベルが古いまま1リリース残った」という同じ誤りを、馬単でも
     * 繰り返さない。#122の時点でscrape-race.tsは馬単オッズも取得し始める
     * (includeComboOdds:trueのとき、ワイド・3連複・馬連の後に馬単を1リクエスト追加で
     * 取得する)ため、チェックボックス・補助文とも「何を取得するか」「その費用」の事実を
     * 更新する。ただし「配分に使うかどうかは下記の設定に従います」という列挙(ワイド・
     * 馬連・三連複の3項目)には馬単を加えない(`includeExactaInAllocation`という設定自体は
     * #24-E3a・Issue #124で新設したが、この画面のチェックボックスを追加するのは
     * #24-E3b・Issue #125であり、実際には配分〈`resolveMixedBetTypes`〉に一切使っていない
     * ため、列挙に足すと事実と食い違う。#125でこの画面のチェックボックスが追加された時点で
     * 初めて4項目に直す。#24-E3a・Issue #124着手前ゲートでの是正: 旧「#123で追加予定」は
     * E3a/E3b/E3cへの分割〈2026-09-26〉より前の記述で、実際にチェックボックスを追加するのは
     * #123自体ではなく#125)。
     */
    it("チェックボックス・補助文がどちらも馬単(exacta)の取得に言及すること(Issue #122。#122から馬単も取得しているため)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.checkbox).toContain("馬単");
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("馬単");
    });

    it("補助文の費用説明が馬単も1レースあたり1リクエスト追加であることに言及すること(Issue #122)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toMatch(/馬単[^。]*1レースあたり[^。]*1リクエスト追加/);
    });

    // 【Issue #125(#24-E3b)で改訂】旧版(#122時点)は「配分に使うかどうかは下記の設定に従う」
    // という列挙が3項目(ワイド・馬連・三連複)のままで、馬単を配分に使う設定への言及を
    // 意図的に含めていなかった(#125でこの画面のチェックボックス自体を追加するまでは、
    // 列挙に足すと存在しないチェックボックスを指す嘘になるため)。#125でチェックボックスを
    // 追加したので、ここで初めて列挙に馬単を加えることが事実になる。
    // 何を保証していたか(新旧対応表):
    //   旧: 「馬単を配分に使う」という言及を含まないこと(列挙が3項目のまま。含めると嘘になる時期)
    //   新: 「馬単を配分に使う」という言及を含むこと(列挙が4項目になった。含めないと事実の
    //       更新漏れ〈#116/#122と同種の欠陥〉になる)
    it("補助文の『配分に使うかどうかは下記の設定に従う』という列挙が4項目(ワイド・馬連・馬単・三連複)になり、馬単を配分に使う設定へも言及すること(Issue #125: この画面にチェックボックスを追加したため、列挙に加えることが初めて事実になる)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("馬単を配分に使う");
    });

    // 【Issue #125で改訂】旧版は「馬単は現在は取得のみで配分には使わない」という状態を
    // 明示していたが、#125で配分に使うようになったため、この断定は事実と食い違う。
    // 何を保証していたか(新旧対応表):
    //   旧: 「馬単は…配分には使いません」という断定を含むこと → 事実と食い違うため削除
    //   新: その断定を含まないこと(古い断定文言が再混入する退行を検知するため)
    it("補助文が『馬単は現在は取得のみで配分には使わない』旨をもう含まないこと(Issue #125: 配分に使うようになったため、この断定は事実と食い違う)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).not.toMatch(/馬単[^。]*配分には使いません/);
    });

    /**
     * Issue #137(#25-E2・オーケストレーター指定2026-09-27): 馬単(#122)・馬連(#116)と
     * 同じ欠陥(取得を先に始めてから、ラベルの更新が1リリース遅れる)を三連単でも
     * 繰り返さない。#137の時点でscrape-race.tsは三連単オッズも取得し始める
     * (includeComboOdds:trueのとき、ワイド・3連複・馬連・馬単の後に三連単を1レースあたり
     * 1リクエスト追加で取得する。ただし**中央競馬のみ**。地方は当面取得しない
     * 〈ユーザー判断2026-09-27〉)ため、チェックボックス・補助文とも「何を取得するか」
     * 「その費用」「地方では取得しないこと」の事実を更新する。
     */
    it("チェックボックス・補助文がどちらも三連単(trifecta)の取得に言及すること(Issue #137。#137から三連単も取得しているため)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.checkbox).toContain("三連単");
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("三連単");
    });

    it("補助文の費用説明が三連単も1レースあたり1リクエスト追加であることに言及すること(Issue #137)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toMatch(/三連単[^。]*1レースあたり[^。]*1リクエスト追加/);
    });

    // ユーザー判断(2026-09-27)「地方は当面取らない」を必ず明示する(オーケストレーター指定)。
    it("補助文が『三連単は地方競馬では取得しません』旨を明示すること(Issue #137・ユーザー判断2026-09-27)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("地方競馬では取得しません");
    });

    // 【Issue #139(#25-E3b)で改訂】旧版(#137時点)は「配分に使うかどうかは下記の設定に従う」
    // という列挙が4項目(ワイド・馬連・馬単・三連複)のままで、三連単を配分に使う設定への
    // 言及を意図的に含めていなかった(#139でこの画面のチェックボックス自体を追加するまでは、
    // 列挙に足すと存在しないチェックボックスを指す嘘になるため)。#139でチェックボックスを
    // 追加したので、ここで初めて列挙に三連単を加えることが事実になる。
    // 何を保証していたか(新旧対応表):
    //   旧: 「三連単を配分に使う」という言及を含まないこと(列挙が4項目のまま。含めると嘘になる時期)
    //   新: 「三連単を配分に使う」という言及を含むこと(列挙が5項目になった。含めないと事実の
    //       更新漏れ〈#116/#122/#137と同種の欠陥〉になる)
    it("補助文の『配分に使うかどうかは下記の設定に従う』という列挙が5項目(ワイド・馬連・馬単・三連複・三連単)になり、三連単を配分に使う設定へも言及すること(Issue #139: この画面にチェックボックスを追加したため、列挙に加えることが初めて事実になる)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("三連単を配分に使う");
    });

    // 【Issue #139で改訂】旧版は「三連単は現在は取得のみで配分には使わない」という状態を
    // 明示していたが、#139で配分に使うようになったため、この断定は事実と食い違う。
    // 何を保証していたか(新旧対応表):
    //   旧: 「三連単は…配分には使いません」という断定を含むこと → 事実と食い違うため削除
    //   新: その断定を含まないこと(古い断定文言が再混入する退行を検知するため)。
    //   ただし「地方競馬では取得しません」(取得自体の非対称性)は別の事実であり引き続き明示する
    //   (上の「地方競馬では取得しません」テストが別途固定する。AC6)。
    it("補助文が『三連単は現在は取得のみで配分には使わない』旨をもう含まないこと(Issue #139: 配分に使うようになったため、この断定は事実と食い違う)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).not.toMatch(/三連単[^。]*配分には使いません/);
    });

    it("『地方競馬では取得しません』旨は引き続き明示すること(Issue #139・AC6: 配分利用と取得可否は別の事実であり、配分に使うようになっても地方非対応の事実は変わらない)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("地方競馬では取得しません");
    });

    /**
     * Issue #148(#26-E2): 馬連(#116)・馬単(#122)・三連単(#137)と同じ欠陥(取得を先に始めてから、
     * ラベルの更新が1リリース遅れる)を枠連でも繰り返さない。#148の時点でscrape-race.tsは枠連
     * オッズも取得し始める(includeComboOdds:trueのとき、他の券種の後に枠連を**中央・地方とも**
     * 1レースあたり常に1リクエスト追加で取得する)ため、チェックボックス・補助文とも
     * 「何を取得するか」「その費用」の事実を更新する。枠連を配分に使う設定は#149(配管のみ。チェックボックスは出さない)で新設し、
     * チェックボックスは#150(画面)まで存在しないため、配分利用の列挙(5項目)には加えず、「取得のみ」の一文を添える。
     */
    it("チェックボックス・補助文がどちらも枠連(bracketQuinella)の取得に言及すること(Issue #148。#148から枠連も取得しているため)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.checkbox).toContain("枠連");
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toContain("枠連");
    });

    it("補助文の費用説明が枠連も1レースあたり常に1リクエスト追加であることに言及すること(Issue #148)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toMatch(/枠連[^。]*1レースあたり[^。]*1リクエスト追加/);
    });

    // 三連単と異なり枠連は中央・地方とも取得する。「地方では取得しません」が枠連に対して
    // 言われていない(三連単の文の中にだけある)ことを、文の切れ目(。)を跨がない形で固定する。
    it("補助文が枠連は中央・地方とも取得する旨を明示し、枠連について『地方競馬では取得しません』と言っていないこと(Issue #148)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toMatch(/枠連[^。]*中央・地方/);
      expect(INCLUDE_COMBO_ODDS_LABELS.help).not.toMatch(/枠連[^。]*地方競馬では取得しません/);
    });

    it("補助文の列挙は枠連を配分に使う設定への言及を含まないこと(Issue #148: 設定のチェックボックス自体が#150まで無い。列挙に足すと嘘になる)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).not.toContain("枠連を配分に使う");
    });

    it("補助文が『枠連は現在は取得のみで配分には使わない』旨を明示すること(Issue #148: 取得と配分利用の状態を混同させないため)", () => {
      expect(INCLUDE_COMBO_ODDS_LABELS.help).toMatch(/枠連[^。]*配分には使いません/);
    });
  });

  describe("INCLUDE_COMBO_ODDS_BATCH_NOTE(一括分析画面の固定注記。機能D-2c第3段・Issue #28)", () => {
    it("空でなく、数値(所要時間等の動的見積り)を含まないこと(#15/第4段のスコープとの境界)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toBeTruthy();
      expect(/[0-9]/.test(INCLUDE_COMBO_ODDS_BATCH_NOTE)).toBe(false);
    });

    // 【機能D-2c第4段・AC19で改訂】新旧対応表はINCLUDE_COMBO_ODDS_LABELS.helpのテストに同じ。
    it("『配分に使うかどうかは別設定に従う』という依存関係を明示し、『記録のみ』という断定を含まないこと(AC19)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("配分に使う");
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).not.toContain("記録のみ");
    });

    it("馬連(quinella)の配分利用にも言及すること(Issue #117)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("馬連");
    });

    // Issue #122(#24-E2): INCLUDE_COMBO_ODDS_LABELSと同じ理由(#116の同種の誤りの再発防止)で、
    // 一括分析画面の注記も「何を取得しているか」の事実を更新する。配分利用の列挙(3項目)は
    // 変えない(INCLUDE_COMBO_ODDS_LABELS.helpと同じ判断)。
    it("馬単(exacta)の取得にも言及すること(Issue #122。取得の事実を更新)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("馬単");
    });

    // 【Issue #125で改訂】INCLUDE_COMBO_ODDS_LABELS.helpのテストと同じ新旧対応表。
    it("馬単を配分に使う設定への言及を含むこと(Issue #125: この画面にチェックボックスを追加したため、列挙に加えることが初めて事実になる)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("馬単を配分に使う");
    });

    it("『馬単は現在は取得のみで配分には使わない』旨をもう含まないこと(Issue #125: 配分に使うようになったため、この断定は事実と食い違う)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).not.toMatch(/馬単[^。]*配分には使いません/);
    });

    // Issue #137(#25-E2): INCLUDE_COMBO_ODDS_LABELSと同じ理由で、一括分析画面の注記も
    // 「何を取得しているか」「地方では取得しないこと」の事実を更新する。配分利用の列挙
    // (4項目)は変えない(INCLUDE_COMBO_ODDS_LABELS.helpと同じ判断)。
    it("三連単(trifecta)の取得にも言及すること(Issue #137。取得の事実を更新)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("三連単");
    });

    it("『三連単は地方競馬では取得しません』旨を明示すること(Issue #137・ユーザー判断2026-09-27)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("地方競馬では取得しません");
    });

    // 【Issue #139で改訂】INCLUDE_COMBO_ODDS_LABELS.helpのテストと同じ新旧対応表。
    it("三連単を配分に使う設定への言及を含むこと(Issue #139: この画面にチェックボックスを追加したため、列挙に加えることが初めて事実になる)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("三連単を配分に使う");
    });

    it("『三連単は現在は取得のみで配分には使わない』旨をもう含まないこと(Issue #139: 配分に使うようになったため、この断定は事実と食い違う)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).not.toMatch(/三連単[^。]*配分には使いません/);
    });

    // Issue #148(#26-E2): INCLUDE_COMBO_ODDS_LABELSと同じ理由で、一括分析画面の注記も
    // 「何を取得しているか」の事実を更新する。配分利用の列挙(5項目)は変えない。
    it("枠連(bracketQuinella)の取得にも言及すること(Issue #148。取得の事実を更新)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toContain("枠連");
    });

    it("枠連を配分に使う設定への言及を含まないこと(Issue #148: 設定のチェックボックス自体が#150まで無い)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).not.toContain("枠連を配分に使う");
    });

    it("『枠連は現在は取得のみで配分には使わない』旨を明示すること(Issue #148)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).toMatch(/枠連[^。]*配分には使いません/);
    });

    it("枠連について『地方競馬では取得しません』と言っていないこと(三連単と異なり枠連は中央・地方とも取得する。Issue #148)", () => {
      expect(INCLUDE_COMBO_ODDS_BATCH_NOTE).not.toMatch(/枠連[^。]*地方競馬では取得しません/);
    });
  });

  // 券種横断の馬券配分対象チェックボックス文言(機能D-2c第4段・Issue #28。
  // Issue #117で馬連〈quinella〉、Issue #125で馬単〈exacta〉、Issue #139で三連単〈trifecta〉を追加)。
  // AC24必須要件3点をwide/quinella/exacta/trio/trifectaそれぞれで個別に固定する(1つだけ直して
  // 他が古い文言のまま残る欠陥を防ぐため、必ず5券種とも同じアサーションを通す)。
  describe("ALLOCATION_BET_TYPE_LABELS(券種横断の配分対象チェックボックス文言。機能D-2c第4段・Issue #28・AC24。Issue #117で馬連、Issue #125で馬単、Issue #139で三連単を追加)", () => {
    it.each(["wide", "quinella", "exacta", "trio", "trifecta"] as const)(
      "%sのチェックボックスラベルが空でない",
      (betType) => {
        expect(ALLOCATION_BET_TYPE_LABELS[betType].checkbox).toBeTruthy();
      },
    );

    it.each(["wide", "quinella", "exacta", "trio", "trifecta"] as const)(
      "%sの補助文がincludeComboOdds(オッズ取得)への依存を明示する(AC24必須要件1)",
      (betType) => {
        // 「オッズ取得がOFFの間は効果がない」ことを書かないと、「ONにしたのに何も変わらない」を
        // 未実装と誤認させる(第3段のINCLUDE_COMBO_ODDS_LABELS.helpと対になる必須記述)。
        // Issue #117: INCLUDE_COMBO_ODDS_LABELS.checkboxが「ワイド・馬連・三連複」に変わったため、
        // ここでの引用文言もそれに合わせる(古い引用のままだと実際のチェックボックス名と
        // 一致しない参照になる)。Issue #122でさらに「ワイド・馬連・馬単・三連複」に変わった
        // ため、引用文言も再度合わせる(同じ理由の繰り返し)。Issue #137でさらに
        // 「ワイド・馬連・馬単・三連複・三連単」に変わったため、引用文言も再度合わせる。
        // Issue #148でさらに「ワイド・馬連・馬単・三連複・三連単・枠連」に変わったため、引用文言も
        // 再度合わせる。あわせて、引用が実際のチェックボックスラベルの部分文字列であることも固定する
        // (引用と本体がまた食い違う欠陥の再発防止。旧版が保証していた「引用にOFFの間は効果が無い旨が
        // 添えられていること」は下の2行で変えていない)。
        const quoted = "ワイド・馬連・馬単・三連複・三連単・枠連のオッズも取得する";
        expect(INCLUDE_COMBO_ODDS_LABELS.checkbox).toContain(quoted);
        expect(ALLOCATION_BET_TYPE_LABELS[betType].help).toContain(quoted);
        expect(ALLOCATION_BET_TYPE_LABELS[betType].help).toContain("OFFの間は効果がありません");
      },
    );

    it.each(["wide", "quinella", "exacta", "trio", "trifecta"] as const)(
      "%sの補助文が既定ONであることを明示する(AC24必須要件3)",
      (betType) => {
        // includeComboOdds自体は既定OFF(オプトイン)だが、この5項目は逆に既定ON(D-1裁定。
        // 馬連はユーザー指定によりIssue #115以降の新券種すべてに適用)。
        // 逆向きの既定値であることを書かないと誤解を招く。
        expect(ALLOCATION_BET_TYPE_LABELS[betType].help).toContain("既定でON");
      },
    );

    it.each(["wide", "quinella", "exacta", "trio", "trifecta"] as const)(
      "%sの補助文が寄り先の券種を断定する表現を含まないこと(AC24必須要件2・AC12と同じ理由)",
      (betType) => {
        // 資金規模・1レース上限・greedySteps(#36)で寄り先が変わるため、断定した瞬間に
        // 条件次第で嘘になる(boss裁定)。「集中」「寄る」「偏る」等の断定語を含まないこと。
        const help = ALLOCATION_BET_TYPE_LABELS[betType].help;
        expect(help).not.toMatch(/集中|寄る|偏る/);
      },
    );

    it("quinellaのチェックボックスラベルが『馬連を馬券配分に使う』であること(wide/trioと同じ命名規則)", () => {
      expect(ALLOCATION_BET_TYPE_LABELS.quinella.checkbox).toBe("馬連を馬券配分に使う");
    });

    it("exactaのチェックボックスラベルが『馬単を馬券配分に使う』であること(wide/quinella/trioと同じ命名規則。Issue #125)", () => {
      expect(ALLOCATION_BET_TYPE_LABELS.exacta.checkbox).toBe("馬単を馬券配分に使う");
    });

    it("trifectaのチェックボックスラベルが『三連単を馬券配分に使う』であること(wide/quinella/exacta/trioと同じ命名規則。Issue #139)", () => {
      expect(ALLOCATION_BET_TYPE_LABELS.trifecta.checkbox).toBe("三連単を馬券配分に使う");
    });
  });
});
