import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildPreviewText } from "../src/prompt-preview";
import { buildClientJs, CLIENT_DIR, GENERATED_PATH, listBundledInputs, renderGeneratedModule } from "../build-client";
import { CLIENT_JS } from "../src/client-bundle.generated";

/**
 * Issue #184: クライアントのバンドル(`client/` → `src/client-bundle.generated.ts`)の検査。
 *  - ドリフト: コミット済みの生成物が、今のソースから再ビルドした出力と一致する(クライアントを直して再生成を忘れると赤になる)
 *  - 決定性: minify により、出力にリポジトリの絶対パス・パスコメントが入らない(入ると cwd・OS で出力が変わり、ドリフトの検査が環境依存になる)
 *  - 静的ガード: HTML を文字列として解釈させる API・eval・Node の組込みを使わない(XSS・CSP)
 *  - 実行スモーク: 生成物を偽の DOM・偽の fetch で評価し、ロードで例外にならず、初回の取得と描画・更新の連打ガードが実際に動く
 */

const ROOT = path.resolve(CLIENT_DIR, "..", "..");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const clientFiles = readdirSync(CLIENT_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(CLIENT_DIR, f));

describe("生成物のドリフトと決定性", () => {
  it("前提: 生成物は空でなく、クライアントのソースがある", () => {
    expect(CLIENT_JS.length).toBeGreaterThan(1000);
    expect(clientFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("コミット済みの CLIENT_JS・生成ファイルが、今のソースから再ビルドした出力と一致する(不一致なら `pnpm run build:client` で再生成する)", async () => {
    const js = await buildClientJs();
    expect(js, "CLIENT_JS が古い。cloud/ で `pnpm run build:client` を実行して再生成する").toBe(CLIENT_JS);
    const file = readFileSync(GENERATED_PATH, "utf-8").replace(/\r\n/g, "\n");
    expect(file).toBe(renderGeneratedModule(js));
  }, 60_000);

  it("出力にリポジトリの絶対パス・パスコメントが入らない(minify。cwd・OS によらず同じ出力になる)", () => {
    expect(CLIENT_JS).not.toContain(ROOT);
    expect(CLIENT_JS).not.toContain("keiba-prediction");
    expect(CLIENT_JS).not.toMatch(/^\s*\/\//m);
  });

  it("対照: minify を外すとパスコメントが入る(上の検査が、実際に入ったときに拾えることの確認)", async () => {
    const unminified = await buildClientJs({ minify: false });
    expect(unminified).toMatch(/^\s*\/\/ client\//m);
    expect(unminified).not.toBe(CLIENT_JS);
  }, 60_000);

  it("生成物は小さい(肥大の検知。上限は 230,500 バイト)", () => {
    // Issue #222: 上限を 125,000 から 175,000 へ引き上げた。移行画面(ファイルのブラウザ検証・アップロード・進捗の表示)を足したため。実測(`pnpm run build:client` が出力する CLIENT_JS のバイト数): #222 の前
    // (421c99c)は 117,977、実装後は 157,309(+39,332)。増分の内訳(esbuild の metafile の `bytesInOutput`): 移行の形式の検証 `cloud-migration-format.ts` 10,437・画面の文言を作る `migration-model.ts` 10,318・
    // API の分類と固定の失敗文言 `api-migration.ts` 7,829・制御 `migration-screen.ts` 2,565・検証 `migration-file.ts` 2,020・行の分割 `src/migration-reader.ts` 1,475、残りは `view.ts`・`dom.ts` の増分。
    // 大半は日本語の文言で、esbuild の既定の `\u` エスケープ(1 文字 6 バイト。`charset` は変えない)で出力されるため大きい。上限 175,000 は実装後の約 11% 増。
    // (経緯)Issue #201: 100,000 → 125,000。設定画面のプレビューが exe と同じ `buildPromptPreview`(build-prompt・clip-variants・condition-change・leg-style・derive-features の 5 ファイル)を取り込んだため。
    // 実測: 3d8a0b1(#198)は 81,269、#201 の実装後は 111,705(+30,436)。
    // Issue #219: 上限を 175,000 から 200,000 へ引き上げた。検証画面(取得・区分の切替・タイル/行の描画・整形・固定の文言)を足したため。実測(`pnpm run build:client` が出力する CLIENT_JS のバイト数): #219 の前
    // (6654946。#218 の承認後)は 164,764、実装後は 182,708(+17,944)。上限 200,000 は実装後の約 9.5% 増。大半は日本語の文言(`\u` エスケープ)。
    // Issue #220: 上限は 200,000 のまま据え置いた(引き上げなし)。検証画面(2)(補正方向・キャリブレーション・印別・版別比較の取得の解釈・整形・描画)を足した実測(CLIENT_JS のバイト数):
    // #220 の前(ac1f311。#230 の承認後)は 182,882、実装後は 192,460(+9,578)。上限までの余裕は約 3.9%(7,540 バイト)なので、**次に検証画面や他の画面を足す Issue は、ここで上限の引き上げが要る見込み**。
    // Issue #236: 上限は据え置き。一覧と見出しに発走予定時刻を足した増分は +175(192,460 → 192,635。上限までの余裕は 7,365 バイト)。
    // Issue #235: 上限を 200,000 から 235,000 へ引き上げた。日報画面(API の検証 `api-report.ts`・状態と制御 `report-screen.ts`・表示用データ `report-model.ts`(確定の注意・作られずに終わった案内の固定文言を含む)・VNode・ルート・入口のリンク)を足したため。
    // 実測(`pnpm run build:client` が出力する CLIENT_JS のバイト数。計り方: 18a2b55〈#236 の承認後〉の生成物と今の生成物を、それぞれ import して `Buffer.byteLength` を取った): 18a2b55 は 192,635、
    // 実装後は 214,711(+22,076)。上限 235,000 は実装後の約 9.5% 増(余裕は 20,289 バイト)。大半は日本語の文言(`\u` エスケープ)。
    // Issue #240: 上限は 235,000 のまま据え置き。結果の「3着内率の上位5頭」(並べ替え・見出し・描画)を足した増分は +851(214,711 → 215,562。上限までの余裕は 19,438 バイト)。
    // Issue #238: 上限は据え置き。閲覧者の画面(役割の読み取り `role.ts`・管理者だけの案内 `admin-only.ts`・入口とボタンの出し分け・閲覧者向けの配分の注記)を足した増分は +1,659(215,562 → 217,221。
    // 計り方: 51541b0〈#240 の承認後〉の生成物と今の生成物を、それぞれ import して `Buffer.byteLength` を取った。今の値は `pnpm run build:client` の出力。上限までの余裕は 17,779 バイト)。
    // Issue #247: 上限は据え置き。馬のカードの単勝の想定・実際の表示(API の検証 `api-analysis.ts` の3項目と `oddsStatus`・カードの表示用データ `result.ts`・VNode `view.ts`・表示の整形 `src/win-odds-format.ts`)を足した増分は +1,686
    // (218,081 → 219,767。計り方: cd78fc2〈#246 の承認後〉の生成物と今の生成物を、それぞれ import して `Buffer.byteLength` を取った。上限までの余裕は 15,233 バイト)。勝率の計算はサーバで行い、クライアントに Plackett-Luce を入れていない
    // (クライアントが推定を呼ぶと束に Plackett-Luce が入って増える。下の「Plackett-Luce が入っていない」テストが、生成物にモデルの文言が無いことで固定する)。
    // Issue #254: 上限を 235,000 から 245,000 へ引き上げた。検証画面の対応表の信頼区間(Wilson 区間と判定 `@keiba/core/ev/binomial-interval`・補正後/補正前の切替・平均予測/95%区間/判定の cell・
    // 説明文・throttled の文言の出し分け・回収率の丸め〈`src/recovery-format`〉)を足した増分は、#254 だけで見ると +3,883(230,093 → 233,976。d99276a〈#255 の承認後〉の生成物との比較)で、
    // その時点では上限 235,000 に収まっていた(余裕 1,024 バイト)。その後 main に入った #261・#260・#262(設定画面のプレビューで client にも入るプロンプトの文面の増加)が重なり、
    // 24e3325 の生成物が 231,913(d99276a から +1,820)、それに #254 を載せた今の生成物が **235,792**(24e3325 から +3,879)で、235,000 を 792 バイト超えた。
    // 計り方: 各コミットの `cloud/src/client-bundle.generated.ts` を import して `Buffer.byteLength(CLIENT_JS)` を取った(今の値は `pnpm run build:client` の出力)。
    // 新しい上限 245,000 は今の大きさの約 3.9% 増(余裕は 9,208 バイト)。増えたのは日本語の文言(`\u` エスケープ)とロジックで、Plackett-Luce などの重い依存は入っていない。
    // Issue #263: 上限は据え置き。閲覧者の検証画面(更新ボタンの出し分け・閲覧者の注記と『まだ集計されていません』の固定文言・追加指示の『あり/なし』の要約・`not-computed` の読み取り・
    // 失敗の文言の閲覧者版)を足した増分は +2,773(235,792 → 238,565。計り方: f867ee9〈#254 の承認後〉の `cloud/src/client-bundle.generated.ts` と今の生成物を、それぞれ import して `Buffer.byteLength(CLIENT_JS)` を取った。
    // 今の値は `pnpm run build:client` の出力。上限までの余裕は 6,435 バイト)。
    // Issue #264: 上限は据え置き。日報の画面に、見込みの項目(全体・券種別)と直近 28 日の累計(`parseOptionalGroup`・`parsePeriod`・`parseRolling`・`statTiles`・`rollingOf`・VNode)、
    // 共有の `src/expected-format` を足した増分は +1,836(238,565 → 240,401。計り方: 6d345a6〈#263 の承認後〉の `cloud/src/client-bundle.generated.ts` と今の生成物を、それぞれ import して
    // `Buffer.byteLength(CLIENT_JS)` を取った。今の値は `pnpm run build:client` の出力。上限までの余裕は 4,599 バイト)。10/12 公開予定の #259・#226 が先に入るので、リベース後に測り直すこと。
    // Issue #253: 上限は据え置き。馬のカードの複勝の想定・実際(下限〜上限)の表示(API の検証 `api-analysis.ts` の3項目と `race.placeBasis`・カードの表示用データ `result.ts`・VNode `view.ts`・
    // 表示の整形 `src/place-odds-format.ts`〈1.0倍未満・幅・上限なし・強調の判定〉と説明文)を足した増分は +2,374(238,565 → 240,939。計り方: 6d345a6〈#263 の承認後〉の `cloud/src/client-bundle.generated.ts` と今の生成物を、
    // それぞれ import して `Buffer.byteLength(CLIENT_JS)` を取った。今の値は `pnpm run build:client` の出力。上限までの余裕は 4,061 バイト)。想定の計算(Plackett-Luce)はサーバで、束には入っていない(下のテストが固定する)。
    // **余裕が 4,061 バイトまで減った**ので、次に画面や文言を足す Issue は、先に上限の引き上げを見込むこと。
    // Issue #72: 上限は据え置き。配分ベースの回収率の返還の表示(応答の検査の 2 項目・「うち返還 N点(金額)」の 1 行・2 つの系の取消・除外の扱いを言う説明文の 2 文)を足した増分は +660
    // (238,565 → 239,225。計り方: 6d345a6〈#263 の承認後〉の `cloud/src/client-bundle.generated.ts` と今の生成物を、それぞれ import して `Buffer.byteLength(CLIENT_JS)` を取った。
    // 今の値は `pnpm run build:client` の出力。上限までの余裕は 5,775 バイト)。
    // Issue #271: 上限を 245,000 から 252,000 へ引き上げた。検証画面の版別カードに、補正前〈統計モデル〉の Brier の 1 行(レース数の足りない版は値を隠す)・補正前の対応表・
    // 応答の検査(`priorCalibration`・`quality`)を足した増分は +1,384(240,298 → 241,682。計り方: origin/issue-16-flat-compare の先端 d34b548 の `cloud/src/client-bundle.generated.ts` と今の生成物を、
    // それぞれ `Buffer.byteLength(CLIENT_JS)` で測った。今の値は `pnpm run build:client` の出力)。この枝だけなら 245,000 に収まる(余裕 3,318 バイト)が、**公開待ちの枝と合わせると超える**:
    // 同じ計り方で、6d345a6〈#263 の承認後〉の 238,565 に対し #253(origin/issue-253-fair-place-odds)の先端は 240,939(+2,374)・#264(origin/issue-264-report-rolling)の先端は 240,401(+1,836)で、
    // 足し合わせた見積もりは 240,298 + 2,374 + 1,836 + 1,384 = 245,892(**加算の見積もりで、4 枝を実際に合流させた測定ではない**。合流で view.ts などが重なれば数百バイトはずれうる)。
    // 新しい上限 252,000 は、その見積もりの約 2.5% 増(余裕は 6,108 バイト)。増えたのは日本語の文言(`\u` エスケープ)とロジックで、Plackett-Luce などの重い依存は入っていない。
    // 実測(2026-10-12 の公開。#259・#226・#264・#253・#266・#267・#72・#16・#271 を本番の先端に合流させた後の `pnpm run build:client` の出力): **245,611 バイト**(見積もりより 281 少ない)。上限までの余裕は 6,389 バイト。
    // Issue #272(日報の「もしも」。印の定型の成績・惜しかったレースの画面と、サーバと共有する `src/whatif-format`)の増分は +3,644(245,611 → 249,255。計り方: 上と同じ。
    // 本番の先端 85db4b3 の `cloud/src/client-bundle.generated.ts` と今の生成物を、それぞれ `Buffer.byteLength(CLIENT_JS)` で測った)。上限は上げていない(余裕は 2,745 バイト)。
    // Issue #273(日報の日付のカレンダー)の公開後の実測: 249,596。
    // Issue #268: 上限を 252,000 から 260,000 へ引き上げた。日報がある日の管理者の「日報を作り直す」(確認の段階・依頼・作り直し中の確認のポーリング・完了と失敗の表示・API の解釈)を足したため。
    //  - 実測値(`Buffer.byteLength(CLIENT_JS)`): 253,654(249,596 → 253,654 で +4,058)。計り方: 本番の先端 6a62599 の `cloud/src/client-bundle.generated.ts`(`git show 6a62599:cloud/src/client-bundle.generated.ts`)と今の生成物を、それぞれ import して測った。
    //    今の値は `pnpm run build:client` の出力〈「253654 バイト」〉と、このテストの対象の `CLIENT_JS` が同じ。
    //  - 増分の内訳: **文言は上界で +1,463**(追加した 9 本の固定文言 1,643 バイト − 差し替えた作成の注意〈「…その日は作り直せません。」〉180 バイト。esbuild の `\u` エスケープに合わせ、ASCII は 1・それ以外は 6 バイトで数えた。
    //    数えたのは `cloud/client/report-model.ts` の `REGEN_*` 5 本・ボタン/確認のラベル 3 本・`CREATE_CAUTION`)、**ロジックは差し引きで約 +2,595**(状態遷移 `report-screen.ts`・モデルの出し分け `report-model.ts`・VNode `view.ts`・
    //    `api-report.ts` の 429 とジョブの `regenerate` の解釈。文言とロジックを別々に測ったものではなく、全体の増分から文言の上界を引いた値)。ロジックを削って収めることはしなかった(確認の文面の事実〈費用・置き換え・上限・Discord に送らない〉は必須)。
    //  - 前の上限 252,000 の根拠: #271 のときに、公開待ちの 4 枝の足し合わせの見積もり 245,892 の約 2.5% 増として置いた(上の #271 の記述)。#272 の公開後は余裕が 2,745 バイト、#273 の公開後は 2,404 バイトで、今回の増分 +4,058 は収まらなかった。
    //  - 新しい上限 260,000 の根拠: 実測 253,654 の約 2.5% 増(253,654 × 1.025 ≈ 259,995 を切り上げ)。余裕は 6,346 バイト。
    // Issue #279(#265-A 月報の統計・保存・画面): 上限を 260,000 から 273,000 へ引き上げた。日報の画面の中に「日 / 月」の切り替えと月報の画面(一覧・本文・日ごとの行・券種別・印別・もしも・版ごと・前後の月への移動)を足したため。
    //  - 実測値(`Buffer.byteLength(CLIENT_JS)`): 266,283(254,415 → 266,283 で +11,868)。計り方: 本番の先端 1cb2924 の `cloud/src/client-bundle.generated.ts`(`git show 1cb2924:cloud/src/client-bundle.generated.ts`)と今の生成物を、
    //    それぞれ import して測った。今の値は `pnpm run build:client` の出力〈「266283 バイト」〉と、このテストの対象の `CLIENT_JS` が同じ。
    //  - 増えた中身: 月報の API の解釈(`api-monthly.ts`)・表示用データ(`monthly-model.ts`)・画面の制御(`monthly-screen.ts`)・VNode(`view.ts`)・ハッシュの解釈(`route.ts`)・アプリの配線(`app.ts`)。
    //    日本語の文言は束の中で 1 字 6 バイト(`\u` エスケープ)になるので、固定の注記の文言が大きな割合を占める。取得の失敗の文言は日報のもの(`reportFetchFailureMessage`)の「日報」を「月報」に読み替えて二重に持たない(実測: 月報専用の文言を持つ版の 267,910 バイトが、読み替えにして 266,283 バイトになった = 1,627 バイト減)。
    //    統計の読み方(`parsePeriod`)・タイルと券種別・印別・もしもの行は日報と共有している(日報側の関数を export しただけ)。
    //  - 事前の見積もりは +8,000〜12,000(日報の画面関連ファイルの束の中の大きさ 29,445 バイトの約 3 分の 1 程度という比例の推定)。実測は見積もりの上端の近くだった。
    //  - 前の上限 260,000 の根拠: Issue #268 のとき、実測 253,654 の約 2.5% 増。#264〜#278 の公開後の実測は 254,415 で、余裕は 5,585 バイトだった。今回の増分 +11,868 は収まらなかった。
    //  - 新しい上限 273,000 の根拠: 実測 266,283 の約 2.5% 増(266,283 × 1.025 ≈ 272,940 を切り上げ)。余裕は 6,717 バイト。段階 B(#280。LLM の文章・作り直しのボタン)は、さらに増える見込みで、そのとき実測値を添えて上げ直す。
    // Issue #280(#265-B 月報の LLM の文章・管理者の作成と作り直し): 上限を 273,000 から 282,200 へ引き上げた。月報の画面に、LLM の文章(総括・良かった点・改善点・来月に向けて・生の文章)、
    // 管理者だけの「この月の月報を作る」「月報を作り直す」(確認つき)、作成中・作り直し中の確認のポーリング(完了・失敗・進行状況を取れない場合の表示)を足したため。
    //  - 実測値(`Buffer.byteLength(CLIENT_JS)`): 275,246(266,283 → 275,246 で +8,963)。計り方: B-1 のコミット 70daa8a の `cloud/src/client-bundle.generated.ts`(`git show 70daa8a:cloud/src/client-bundle.generated.ts`)と今の生成物を、
    //    それぞれ import して測った。今の値は `pnpm run build:client` の出力〈「275246 バイト」〉と、このテストの対象の `CLIENT_JS` が同じ。
    //  - 増えた中身: 月報の API の解釈(`api-monthly.ts`。文章・進行状況・POST。進行状況の読み方と POST の分類は日報のもの〈`api-report.ts`〉を `parseJobOf`・`postRun` として共有した)・表示用データ(`monthly-model.ts`)・
    //    画面の制御(`monthly-screen.ts`。作成・作り直し・ポーリング)・VNode(`view.ts`。日報と月報で操作のボタンを共有)・アプリの配線(`app.ts`)。
    //  - 文言は約 2,726 バイト(月報専用の固定文言 10 本。日本語は束の中で 1 字 6 バイトで数えた。`cloud/client/monthly-model.ts` の `MONTHLY_RAW_NOTE`・`MONTHLY_CREATE_CAUTION`・`MONTHLY_REGEN_*`・`MONTHLY_CREAT*`・`MONTHLY_NO_REPORT_NOTICE`)。
    //    残りの約 6,200 はロジック(全体の増分から文言を引いた値)。日報の文言・関数は再利用して二重に持たない(`JOB_UNAVAILABLE_NOTICE`・`REGEN_LIMIT_MESSAGE`・`reportRunFailureMessage`・`REPORT_POLL_MS` ほか)。
    //  - 事前の見積もり(B-1 の着手前の報告)は +5,000〜7,000(日報の作り直し #268 の +4,058 からの類推)。実測は見積もりを上回った。ロジックを削って収めることはしなかった(確認の文面の事実〈費用・置き換え・上限・Discord に送らない〉と、進行状況を取れない場合の確認の継続は必須)。
    //  - 前の上限 273,000 の根拠: Issue #279 のとき、実測 266,283 の約 2.5% 増。今回の増分 +8,963 は余裕 6,717 に収まらなかった。
    //  - 新しい上限 282,200 の根拠: 実測 275,246 の約 2.5% 増(275,246 × 1.025 ≈ 282,127 を 100 バイト単位に切り上げ)。余裕は 6,954 バイト。
    // Issue #295: 上限は据え置き(収まった)。設定画面のプレビューが束に入れる `buildPrompt` に、当日の馬場の節(`day-baba.ts`: 正規化・コース種別での絞り込み・行の整形・固定の注記)を足したことと、
    // 分析の画面の「AI に渡した当日の馬場」の節(API の `baba` の解釈 `api-analysis.ts`・表示用データ `result.ts`・VNode `view.ts`)・設定画面の注記を足した増分は +5,895(275,202 → 281,097)。
    // 計り方: a1b185d〈#294 の承認後〉の `cloud/src/client-bundle.generated.ts` の `CLIENT_JS` と今の生成物を、それぞれ文字列として取り出して `Buffer.byteLength` を取った。今の値は `pnpm run build:client` の出力〈「281097 バイト」〉。
    // 上限 282,200 までの余裕は **1,103 バイトまで減った**ので、次に画面や文言を足す Issue は、先に上限の引き上げを見込むこと。
    // Issue #296: 上限は据え置き(収まった)。分析の画面の「配分の提案」の下の組合せの券種ごとの行(API の `combos` の解釈 `api-analysis.ts`・表示用データ `result.ts`・VNode `view.ts`)を足した増分は +222(281,097 → 281,319。
    // `pnpm run build:client` の出力〈「281319 バイト」〉)。文言はサーバ(`src/combo-counts-view.ts`)で組み立ててクライアントには置かず〈日本語は `\u` エスケープで 1 文字 6 バイト〉、
    // `parseBaba` を `baba` と `combos` で共有する `parseLines` に改めたので小さく収まった。余裕は **881 バイト**。
    // Issue #308(#302-B 移行ファイルの値の検証): 上限を 282,200 から 288,600 へ引き上げた。移行ファイルの値の規則(race_id・kaisai_date・analyzed_at・umaban・bet_type・combo_key・長さ・子の行数)を
    // core の `cloud-migration-format.ts` に足し、ブラウザのアップロード前の検証にも効かせるため。実測(`pnpm run build:client` が出力する CLIENT_JS のバイト数): 9ce3776〈#307 の承認後〉は 281,319、
    // 実装後は 287,525(+6,206)。増分の内訳(esbuild の metafile の `bytesInOutput`。minify あり): `scraper/ids.ts` 2,205(`parseRaceId`・`parseKaisaiDate` を使うため新たにバンドルへ入った。
    // 大半は `InvalidIdError` の日本語メッセージで、移行の検証では捨てている)・`ev/cloud-migration-format.ts` 14,146(#222 の実装時は 10,437 で、以後は JSDoc の変更だけなので +約 3.7KB。規則・日本語メッセージ・定数)・
    // `scraper/combo-odds-key.ts` は 519(もとから入っていた。`parseComboOddsKey` などで少量増えた)。計り方: 9ce3776 の `cloud/src/client-bundle.generated.ts` と今の生成物を、それぞれ import して
    // `Buffer.byteLength` を取り、内訳は `cloud/` で esbuild を `build-client.ts` と同じ設定(minify・metafile)で呼び、`outputs[...].inputs[ファイル].bytesInOutput` を読んだ。
    // 新しい上限 288,600 の根拠: 実測 287,525 に約 1KB の余裕(287,525 + 1,075 を 100 バイト単位に切り上げ)。余裕は 1,075 バイト。
    // Issue #311(レース再生): 上限を 288,600 から 296,400 へ引き上げた。結果の画面とレース画面の発走前のカードに「レース再生」(Plackett-Luce の逐次抽選・位置の計算・簡略化したコース図のキャンバス描画・
    // アニメーションのプレーヤ〈rAF・可視状態・reduced-motion〉・再生/速度のボタン・演出の注記)を足したため。実測(`Buffer.byteLength(CLIENT_JS)`): 2cb0b5c〈#306 の承認後の main〉は 287,525、
    // 段階 A のコミット c9691eb は 287,715(+190。API の `earlyPos`・`turn`・`distance` の読み取りだけ。純関数は未配線で束に入らない)、実装後は 295,327(2cb0b5c から +7,802)。
    // 計り方: 2cb0b5c と c9691eb の `cloud/src/client-bundle.generated.ts`(`git show <コミット>:cloud/src/client-bundle.generated.ts`)と今の生成物を、それぞれ import して `Buffer.byteLength` を取った
    // (今の値は `pnpm run build:client` の出力〈「295327 バイト」〉)。内訳(`cloud/` で esbuild を `build-client.ts` と同じ設定〈minify・metafile〉で呼び、`outputs[...].inputs[ファイル].bytesInOutput` を読んだ):
    // 新しいファイル `replay-model.ts` 2,621(抽選・開始順位・位置の計算・再生の材料・表示用データ。日本語の文言を含む)・`replay-player.ts` 1,536・`replay-draw.ts` 1,510 の計 5,667。
    // 残りの 2,135 は `view.ts`(節の VNode)・`app.ts`(再生の状態と配線)・`api-analysis.ts`・`result.ts`・`race.ts`・`main.ts`(プレーヤの配線・色の読み取り)・`dom.ts` の増分(ファイル別の差は測っていない)。
    // 事前の見積もり(着手前の報告)は +6〜9KB で、実測はその範囲。外部ライブラリは使っていない。Plackett-Luce は client 専用の自前の逐次抽選で、core の `PLACKETT_LUCE_MODEL`・`winProbabilitiesFromStrengths` は束に入っていない(下のテストが固定する)。
    // 新しい上限 296,400 の根拠: 実測 295,327 に約 1KB の余裕(295,327 + 1,073 を 100 バイト単位に切り上げ)。余裕は 1,073 バイト。
    // Issue #314(レース再生の見た目の改善): 上限を 296,400 から 300,000 へ引き上げた。脚質と想定ペースで決まる隊列・馬ごとに連続な横位置の前計算(新しいファイル `replay-plan.ts`)・API の `legStyle`/`race.pace` の読み取り・
    // 「もう一度再生」のボタンと制御・コース幅の拡張(5 → 7 車線)を足したため。実測(`Buffer.byteLength(CLIENT_JS)`): fd6d0c0〈#311 の承認後〉は 295,327、実装後は 299,066(+3,739。最初の実装は 298,997 で、前方位置の後退の防御〈`replay-plan.ts` の 7 行〉で +69)。
    // 計り方: fd6d0c0 の `cloud/src/client-bundle.generated.ts`(`git show fd6d0c0:cloud/src/client-bundle.generated.ts`)と今の生成物を、それぞれ import して `Buffer.byteLength` を取った(今の値は `pnpm run build:client` の出力〈「299066 バイト」〉)。
    // 内訳(`cloud/` で esbuild を `build-client.ts` と同じ設定〈minify・metafile〉で呼び、`outputs[...].inputs[ファイル].bytesInOutput` を読んだ。今の値): 新しいファイル `replay-plan.ts` 2,492、`replay-player.ts` 1,960・`replay-draw.ts` 1,651・`replay-model.ts` 2,753
    // (#311 のコメントに書いた値は 1,536・1,510・2,621 で、その差は +424・+141・+132)。残りの約 550 は `api-analysis.ts`・`view.ts`・`app.ts` の増分(ファイル別の差は測っていない)。外部ライブラリは使っていない。
    // 新しい上限 300,000 の根拠: 最初の実測 298,997 に約 1KB の余裕(298,997 + 1,003 を 100 バイト単位に切り上げ)。防御を足した今の実測 299,066 での余裕は 934 バイト(上限は据え置き)。
    // Issue #315(想定ペースを LLM に展開予想させて決める): 上限を 300,000 から 305,300 へ引き上げた。増える理由は 2 つ。
    //  (1) **クライアントの束は設定画面のプロンプトのプレビューのために core の `buildPromptPreview`(`@keiba/core/analyzer/build-prompt`)を含むので、プロンプトの文面が増えると束も増える**。
    //      【指示】の先頭に判断の手順と development・pace の出力仕様(2 段落)、【展開想定】の導入と注記の行、各馬の行の「テンの位置」の組み立て(新しい `early-position.ts` の `summarizeEarlyPosition`)を足し、規則の結論 3 行を外した。
    //  (2) 分析の画面に「AI の展開予想」の節を足した(`api-analysis.ts` の `parseDevelopment`・`result.ts` の `DevelopmentSection`・`view.ts` の `developmentSection`)。
    // 実測(`Buffer.byteLength(CLIENT_JS)`): #316 の公開先端 eab84df は 299,571、core だけを #316 の先端に merge した時点は 303,457(+3,886。(1) の増分。`cloud/client/` を変えないで core だけ変えた版は、daa1301 の 299,066 から 302,952 で、同じ +3,886)、
    // 画面を足した最終は 304,261(+804。(2) の増分)。計り方: `pnpm run build:client` の出力〈「生成しました: …(N バイト)」〉と、`git show eab84df:cloud/src/client-bundle.generated.ts` を import して `Buffer.byteLength` を取った値。外部ライブラリは使っていない。
    // 新しい上限 305,300 の根拠: 実測 304,261 に約 1KB の余裕(304,261 + 1,039 を 100 バイト単位に切り上げ)。余裕は 1,039 バイト。
    // Issue #312(手動の分析の案内と、AI補正後の変化量): 上限を 305,300 から 307,100 へ引き上げた。足したもの: レースの画面の案内の文(`race.ts` の `RACE_GUIDE`・`RaceModel.guide`・`view.ts` の `p.race-guide`)、
    // 馬のカードと「3着内率の上位5頭」の行に添える統計モデルからの変化量(`result.ts` の `probShiftOf`・`shiftNote`・`HorseCard.adjustedShift`・`TopProbHorse.shift`、検証画面の `formatAdjustment` の再利用)。日本語の文言は `\u` エスケープで大きくなる。
    // 実測(`Buffer.byteLength(CLIENT_JS)`): de78787〈#310 の承認後〉は 304,953、実装後は 306,008(+1,055)。計り方: `git show de78787:cloud/src/client-bundle.generated.ts` と今の生成物を、それぞれ import して `Buffer.byteLength` を取った(今の値は `pnpm run build:client` の出力〈「306008 バイト」〉)。
    // 新しい上限 307,100 の根拠: 実測 306,008 に約 1KB の余裕(306,008 + 1,092 を 100 バイト単位に切り上げ)。余裕は 1,092 バイト。外部ライブラリは使っていない。
    // Issue #344(#335-A2 結果画面の「締切直前の再計算」の節): 上限を 307,100 から 308,600 へ引き上げた。足したもの: API の `close` の解釈(`api-analysis.ts` の `parseClose`)・表示用データ(`result.ts` の `closeOf`・
    // 注記の差し替えの共有関数 `noticesOf`)・VNode(`view.ts` の `closeSection`・買い目の表の 1 行 `betRow`〈配分の提案と共有〉)・core の `betRowLabels`(サーバが差分の行に使う関数で、束には薄い包みだけが入る)。
    // 文言(状態・理由・時刻・遅れ・差分の行・説明文)はサーバ(`src/close-view.ts`)で組み立てて、クライアントには置かない〈日本語は `\u` エスケープで 1 文字 6 バイト〉。
    // 実測(`Buffer.byteLength(CLIENT_JS)`): 30790e1〈#338 の公開後の作業ブランチ〉は 306,008、実装後は 307,564(+1,556。`pnpm run build:client` の出力〈「307564 バイト」〉)。
    // 内訳(`cloud/` で esbuild を `build-client.ts` と同じ設定〈minify・metafile〉で呼び、`outputs[...].inputs[ファイル].bytesInOutput` を読んだ。30790e1 → 実装後): `client/api-analysis.ts` 5,201 → 5,850(+649)・
    // `client/view.ts` 30,257 → 30,752(+495)・`client/result.ts` 4,928 → 5,312(+384)・`packages/core/src/view/allocation-proposal-view.ts` 6,214 → 6,242(+28)。4 つの和は 1,556 で全体の増分と一致する。
    // 計り方(全体): 30790e1 の `cloud/src/client-bundle.generated.ts`(`git show 30790e1:cloud/src/client-bundle.generated.ts`)と今の生成物を、それぞれ import して `Buffer.byteLength` を取った。外部ライブラリは使っていない。
    // 新しい上限 308,600 の根拠: 実測 307,564 に約 1KB の余裕(307,564 + 1,036 を 100 バイト単位に切り上げ)。余裕は 1,036 バイト。
    // Issue #336(段階 B 今日の狙い目の画面): 上限を 308,600 から 313,800 へ引き上げた。新しい画面(`#targets`)を 1 つ足したため: API の解釈(`api-targets.ts`)・表示用データ(`targets-model.ts`。未発走/発走済みの分け方と残り時間の文言)・
    // 画面の制御(`targets-screen.ts`。取得・30 秒ごとの再描画・3 分ごとの取り直し・見えている間だけ・回数の上限)・VNode(`view.ts` の `targetsScreen`・`targetRow`)・ルート(`#targets`)・一覧の入口のリンク・`app.ts` の配線。
    // 文言(要約・場と R・◎・2 行目)はサーバ(`src/targets-view.ts`)で組み立てて、クライアントには置かない〈日本語は `\u` エスケープで 1 文字 6 バイト〉。置いた日本語は、見出し・ボタン・残り時間の語(あと・分・時間・まもなく・発走済み・時刻不明)だけ。
    // 実測(`Buffer.byteLength(CLIENT_JS)`): d3fccb2〈#344 の公開後〉は 307,564、実装後は 312,373(+4,809。`pnpm run build:client` の出力〈「312373 バイト」〉)。
    // 内訳(`cloud/` で esbuild を `build-client.ts` と同じ設定〈minify・metafile〉で呼び、`metafile.outputs[...].inputs[ファイル].bytesInOutput` を前後で比べた。d3fccb2 → 実装後): 新規 `client/targets-screen.ts` 0 → 1,154・`client/targets-model.ts` 0 → 963・`client/api-targets.ts` 0 → 786・
    // `client/view.ts` 30,752 → 31,946(+1,194。発走済みの行を薄くする `past` のクラスを含む)・`client/app.ts` 13,059 → 13,426(+367)・`client/route.ts` 1,652 → 1,974(+322)・`client/list.ts` 2,409 → 2,432(+23)。7 つの和は 786 + 367 + 23 + 322 + 963 + 1,154 + 1,194 = 4,809 で全体の増分と一致する。
    // 計り方(全体): d3fccb2 の `cloud/client` と今の `cloud/client` を、それぞれ同じ設定で esbuild に通して `Buffer.byteLength` を取った(前は `git show d3fccb2:cloud/src/client-bundle.generated.ts` の長さとも一致)。外部ライブラリは使っていない。
    // 転送量への影響は小さい: 圧縮後は #336 の前で約 80 KB(出力を `zlib.gzipSync` に通した長さ)。上限は転送量ではなく肥大の検知。
    // 新しい上限 313,800 の根拠: 実測 312,373 に約 1.5KB の余裕(312,373 + 1,427 を 100 バイト単位に切り上げ)。余裕は 1,427 バイト。
    // Issue #346(一覧の発走済みを下へ回して薄く出す): 上限は 313,800 のまま据え置き。実測(`Buffer.byteLength(CLIENT_JS)`。`pnpm run build:client` の出力)は 312,373 → 313,031(+658)で、余裕は 769 バイト(レビューの修正で、発走済みのクラスを `past` から `started` に変えた分が +6)。
    // 増えた理由: 共通の判定 `hasStarted`(`bulk.ts`)・並べ替えと `past` の印・`needsListClock`(`list.ts`)・30 秒の再描画のタイマー(新規 `list-clock.ts`)・`view.ts` のクラス・`app.ts` の配線(`render` の末尾の `sync`・表示の復帰)。
    // Issue #352(#335-C 検証画面の「締切直前の再計算との比較」の節): 上限を 313,800 から 317,500 へ引き上げた。足したもの: API の `closeComparison` の解釈(`api-verify.ts` の `parseCloseComparison`ほか。壊れた値はこの節だけ null に落とす)・
    // 表示用データ(`verify-model.ts` の `closeSection`。行のラベル・件数・回収率・投資額・「参考」の印・固定の注記)・VNode(`view.ts` の節)。文言は日本語で `\u` エスケープ(1 文字 6 バイト)になるので、説明と注記の固定文が大きな割合を占める。
    // 実測(`Buffer.byteLength(CLIENT_JS)`): 313,031(#346 の後。`git show HEAD:cloud/src/client-bundle.generated.ts` を測った)→ 316,070(+3,039。`pnpm run build:client` の出力〈「316070 バイト」〉)。
    // 内訳(`cloud/` で esbuild を `build-client.ts` と同じ設定〈minify・metafile〉で呼び、`metafile.outputs[...].inputs[ファイル].bytesInOutput` を前後で比べた。HEAD を `git archive` で展開したものと今の作業ツリー): `client/verify-model.ts` 17,189 → 19,298(+2,109)・
    // `client/api-verify.ts` 9,637 → 10,329(+692)・`client/view.ts` 31,971 → 32,186(+215)。残り +23 は、ソースを変えていない 7 ファイルの +2〜+8(minify の識別子の割り当てが変わった分。`app.ts` +8・`replay-plan.ts` +5・ほか 5 ファイルが +2 ずつ)。
    // 全 10 ファイルの増分の和は 2 + 692 + 8 + 2 + 2 + 5 + 2 + 2,109 + 2 + 215 = 3,039 で、全体の増分と一致する。外部ライブラリは使っていない。
    // 新しい上限 317,500 の根拠: 実測 316,070 に約 1.4KB の余裕(316,070 + 1,430 を 100 バイト単位に切り上げ)。余裕は 1,430 バイト。
    // Issue #353(タイム指数の重みを設定画面の 14 番目に足した): 上限は 317,500(#352)のまま据え置き。実測(`Buffer.byteLength(CLIENT_JS)`。`pnpm run build:client` の出力)は 316,070(#352 の後)→ 316,507(+437)で、余裕は 993 バイト。
    // 増えた理由: 重みの対応表の 1 行(`settings.ts`)・既定値・ラベル「タイム指数」(core の `app-settings.ts`)・タイム指数の欄の補助文(`settings-form.ts`。単位が他の重みと違うため。1 文字 6 バイトで出力される)。節の説明の「既定値は、タイム指数を除いて exe と同じです」への修正(+60)。
    // Issue #361(今日の狙い目に収支の途中経過を出す): 上限を 317,500 から 319,000 に上げた。実測(同上)は 317,004(d375c1e=#354 の先端)→ 317,605(+601)で、新しい上限までの余裕は 1,395 バイト。
    // 増えた理由: 応答のパーサに 3 項目(各行の結果の状態・文言と、上部の合計。`api-targets.ts`)・行の表示用データに 2 項目と「発走済みの行にだけ出す」判定(`targets-model.ts`)・
    // 行の結果の 1 要素と上部の合計の 1 要素(`view.ts`)・結果待ちの行が残るあいだ取り直しを続ける条件(`targets-screen.ts`)。**文言は 1 つもクライアントに置いていない**(サーバが組み立てる。日本語は `\uXXXX` で 1 文字 6 バイトになるため)。
    // Issue #362(レース再生を廃止し、静止した想定隊列図に置き換えた): 上限を 317,500 から 312,000 へ**下げた**。実測(`Buffer.byteLength(CLIENT_JS)`): 317,004(d375c1e。#353・#354 を含む)→ 310,079(-6,925。`pnpm run build:client` の出力〈「310079 バイト」〉)。
    // 内訳(`cloud/` で esbuild を `build-client.ts` と同じ設定〈minify・metafile〉で呼び、`metafile.outputs[...].inputs[ファイル].bytesInOutput` を d375c1e の `cloud/` と今の作業ツリーで比べた): 削除した `replay-model.ts` 3,198・`replay-plan.ts` 2,492・`replay-player.ts` 1,960・`replay-draw.ts` 1,657(計 9,307)・
    // `app.ts` 13,614 → 13,082(-532。再生の状態と操作)・`main.ts` 1,264 → 588(-676。プレーヤの配線)・`view.ts` 32,186 → 32,021(-165。再生の節を外し、隊列図の節を足した差)、新しい `formation-model.ts` +3,803(位置の計算・文言・凡例)。残りは 18 ファイルの合計 -48(minify の識別子の割り当ての変化ほか)。
    // 全体の増減の和: -9,307 - 532 - 676 - 165 + 3,803 - 48 = -6,925 で、全体の増分と一致する。外部ライブラリは使っていない。
    // 新しい上限 312,000 の根拠: 実測 310,079 に約 1.9KB の余裕(310,079 + 1,921 を 1,000 バイト単位に切り上げ)。余裕は 1,921 バイト。
    // #361 と #362 を合わせた公開(#361 の後に #362 を載せた): 上限は 312,500。実測(同上)は 310,680(#361 単独の 317,605 から #362 の削減が効いた値)で、余裕は 1,820 バイト。
    // Issue #359(結果の各馬の行にタイム指数の値とレース内の順位を出す): 上限は 312,500 のまま据え置き。実測(`Buffer.byteLength(CLIENT_JS)`。`pnpm run build:client` の出力)は 310,680(d44a467=#362 の後)→ 311,070(+390)で、余裕は 1,430 バイト。
    // 増えた理由: 応答のパーサに 2 項目(馬ごとの `timeIndexLine` と分析の `timeIndexNote`。`api-analysis.ts`)・表示用データに 2 項目(`result.ts`)・VNode 2 要素(馬の行と説明の 1 段落。`view.ts`)。**文言は 1 つもクライアントに置いていない**
    // (サーバの `analysis-view.ts` が組み立てる。日本語は `\uXXXX` で 1 文字 6 バイトになるため)。順位の計算・値の書式・core のタイム指数の定数もサーバ側で、束には入っていない。
    // Issue #363(想定隊列図の4コーナーの位置に、馬ごとの近走の4コーナーの通過順位を使う): 上限は 312,500 のまま据え置き。実測(`Buffer.byteLength(CLIENT_JS)`。`pnpm run build:client` の出力)は 311,070(14104ec)→ 311,412(+342)で、余裕は 1,088 バイト。
    // 増えた理由: 応答のパーサに 1 項目(馬ごとの `latePos`。`api-analysis.ts`)・4コーナーの位置の計算(`formation-model.ts` の `cornerGaps`)・図の注記(`FORMATION_NOTE`)の文言の追加。日本語は `\uXXXX` で 1 文字 6 バイトになる。
    // Issue #371(設定画面の補助文〈タイム指数・調教師成績〉に「障害には効かない」を足す): 上限は 312,500 のまま据え置き。実測(`Buffer.byteLength(CLIENT_JS)`。`pnpm run build:client` の出力)は 311,412 → 311,512(+100)で、余裕は 988 バイト。
    // Issue #375 の C1(想定隊列図の4コーナーの混在時のずれと注記・`race.turn` の削除): 上限は据え置き。実測(`pnpm run build:client` の出力)は 311,512 → 311,658(+146)。増えたのは古い分析の注記の頭の文言(#362 のときの文言)と切り替え、
    // 減ったのは API の `race.turn` の読み取り(パーサの検査と型)。
    // Issue #375 の C2(設定の保存で項目の過不足の 400 のとき、画面が古い可能性を案内する): 上限は 312,500 のまま据え置き。実測(`pnpm run build:client` の出力)は 311,658 → 312,116(+458)で、余裕は 384 バイト。
    // 増えたのは案内の文言 1 本(`api-settings.ts`。55 字 × 6 バイト = 330 バイト)と、400 の `error.reason` を読む分類(`classifyFailure`)。**余裕が 400 を切ったので、次に画面や文言を足す Issue は、先に上限の引き上げを見込むこと。**
    // Issue #379(#335-N。検証画面の「締切直前の再計算との比較」を、地方を含めて区分のタブに従わせ、取り直しの基準で行を分ける): 上限は 312,500 のまま据え置き(下げない。下げるかは別に判断する)。実測(`Buffer.byteLength(CLIENT_JS)`。
    // `pnpm run build:client` の出力)は 312,116 → 311,490(-626)で、余裕は 1,010 バイト。減った理由: 節の説明文(827 バイト。中央のレースだけ・区分のタブに依らない旨)をクライアントから外し、サーバが組み立てて渡す形にした
    // (`verify-close.ts` の `CLOSE_COMPARISON_DESCRIPTION`)。増えたのは、応答のパーサの 2 項目(節の `description`・行の `basisLabel`。`api-verify.ts`)と、行の見出しに語を足す分岐(`verify-model.ts`)。
    // **文言は 1 つもクライアントに足していない**(日本語は `\uXXXX` で 1 文字 6 バイトになるため、サーバに置く)。
    // Issue #384(検証画面に「人気帯ごとの期待値と回収率」「単勝人気と複勝順位のずれ」の節を足す): 上限を 312,500 から 313,500 へ引き上げた。実測(`Buffer.byteLength(CLIENT_JS)`。`pnpm run build:client` の出力〈「312519 バイト」〉)は
    // 311,490(#379 の後。6c37979)→ 312,519(+1,029)で、旧い上限を 19 バイト超えた。新しい上限までの余裕は 981 バイト。
    // 内訳(`cloud/` で esbuild を `build-client.ts` と同じ設定〈minify・metafile〉で呼び、`metafile.outputs[...].inputs[ファイル].bytesInOutput` を前後で比べた。6c37979 を `git archive` で展開したものと今の作業ツリー):
    // `client/api-verify.ts` 10,462 → 11,079(+617。応答の `breakdown` の検査 `parseBreakdown` と、節・行・項目の型)・`client/verify-model.ts` 18,538 → 18,734(+196。表示用データへの写し `breakdownSections`)・
    // `client/view.ts` 32,365 → 32,581(+216。節の VNode)。ほかのファイルの増減は 0。3 ファイルの増分の和は 617 + 196 + 216 = 1,029 で、全体の増分と一致する。外部ライブラリは使っていない。
    // **文言は 1 つもクライアントに置いていない**: 節の見出し・説明・注記・行の見出し・項目の名前と値を、サーバが文字列に組み立てて渡し(`cloud/src/verify-breakdown.ts`)、クライアントは汎用の表として描くだけ(日本語は `\uXXXX` で 1 文字 6 バイトになるため。#379 と同じ流儀)。
    // 節の数・帯の数・券種のグループ(複勝・単勝・ワイド・組合せ・単複のずれ)はサーバ側の定義で、後から増やしてもクライアントの束は変わらない(Issue #385-A の条件別の節〈競馬場・頭数・開催区分〉もこの汎用の表に載せた。応答の検査の行数の上限を 30 から 50 に上げたが、桁数が同じなので束は 312,519 バイトのまま変わらない)。
    // **さらに上げるときは、増える理由と実測値をここに書く。**
    // Issue #394(#390 D-2。exe からの移行機能の廃止): 上限を 313,500 から 266,000 へ**下げた**。移行画面(`client/api-migration.ts`・`migration-model.ts`・`migration-screen.ts`・`migration-file.ts`)と、
    // それだけが使っていた core の `ev/cloud-migration-format.ts` と `src/migration-reader.ts` を、クライアントから外したため。実測(`Buffer.byteLength(CLIENT_JS)`): 312,505(46410ab)→ 264,471(-48,034。`pnpm run build:client` の出力〈「264471 バイト」〉)。
    // 内訳: 移行の名前を持つ 6 つの入力(esbuild の metafile の `bytesInOutput`。46410ab で測った)は 14,146 + 12,202 + 8,482 + 2,728 + 2,020 + 1,476 = 41,054。残りの 48,034 - 41,054 = 6,980 は、
    // `view.ts`(設定画面の節・移行画面の描画)・`app.ts`(移行画面の配線)・`route.ts`・`settings-form.ts`・`dom.ts`(`accept`・`on.file` の許可)・`main.ts`・`vnode.ts` から減った分(ファイルごとの内訳は測っていない)。
    // 新しい上限 266,000 の根拠: 実測 264,471 に約 1.5KB の余裕(#362 の前例。264,471 + 1,529 を 1,000 バイト単位に切り上げ)。余裕は 1,529 バイト。
    // Issue #396(#390 D-3。設定画面のプロンプトのプレビューを、サーバが組み立てて返す): 上限を 266,000 から 228,500 へ**下げた**。クライアントが `build-prompt` を動かして組み立てていたのをやめ、
    // `POST /api/settings/prompt-preview`(`cloud/src/prompt-preview.ts`)の応答を表示するだけにしたため。実測(`Buffer.byteLength(CLIENT_JS)`): 264,471(10eaa26)→ 226,688(-37,783。`pnpm run build:client` の出力〈「226688 バイト」〉)。
    // 内訳(esbuild の metafile の `bytesInOutput` を、10eaa26 と今の生成物で入力ごとに比べた。和が -37,783 に一致する): 外れた core の 8 つ(`analyzer/build-prompt.ts` 28,014・`leg-style.ts` 4,762・`day-baba.ts` 4,456・`condition-change.ts` 1,331・
    // `early-position.ts` 416・`clip-variants.ts` 290・`scorer/derive-features.ts` 180・`ev/allocation-primitives.ts` の使われなくなった分 57)の和は -39,506。`client/prompt-preview.ts` -146、`src/settings.ts` -160(クライアントが追加指示を切らなくなった)、
    // 増えたのは `client/api-prompt-preview.ts` +1,101(新設。API 呼び出し・応答の検査・固定の失敗文言)・`client/app.ts` +776(取得の状態・連番・応答の到着時の入力の保護)・`client/settings-form.ts` +160(取得中の固定の文言・状態の入力)で、
    // ほかに `report-screen.ts` -10・`verify-screen.ts` +2(圧縮の名前の割り当ての揺れ)。-39,506 - 146 - 160 + 1,101 + 776 + 160 - 10 + 2 = -37,783。
    // 副次効果: core のプロンプトの文面(`build-prompt.ts` ほか)を変えても `CLIENT_JS` が変わらなくなった(以前は変えるたびに、この生成物のドリフトの検査が落ちた)。
    // 新しい上限 228,500 の根拠: 実測 226,688 に約 1.8KB の余裕(226,688 + 1,812 を 500 バイト単位に切り上げ)。余裕は 1,812 バイト。
    // (追記)レビューの R1(設定を取り直したとき、飛んでいるプレビューの状態を捨てる 2 行)で 226,688 → 226,702(+14)。上限は 228,500 のまま(余裕 1,798 バイト)。
    // (追記)Issue #397 R-3(検証画面の整形を core の 1 本にまとめた): 226,702 → 226,641(-61。`pnpm run build:client` の出力〈「226641 バイト」〉。`Buffer.byteLength(CLIENT_JS)`)。client に複製していた `formatYen` が core 版と二重に入っていたのが 1 つになった分。上限は 228,500 のまま(余裕 1,859 バイト)。
    // (追記)Issue #397 R-5(JST・印の並び・型ガードを core の `common/` の 1 本にまとめた): 226,641 → 226,589(-52。`pnpm run build:client` の出力〈「226589 バイト」〉。`Buffer.byteLength(CLIENT_JS)`)。上限は 228,500 のまま(余裕 1,911 バイト)。
    // (追記)Issue #397 R-6 の 1 つ目(client の API 層の送受信まわりを `api.ts` の `getJson`・`postJson`・`readBody`・`classifyWrite`・`classifyWithoutNetkeiba`・`isArr`・`isStrArr` にまとめた): 226,589 → 224,931(-1,658。`pnpm run build:client` の出力〈「224931 バイト」〉。`Buffer.byteLength(CLIENT_JS)`)。素書きの fetch の init と try/catch 11 か所(GET 6・POST 5。うち `fetchPromptPreview` は init の組み立てだけ共通)が小さな呼び出しになった分。上限は 228,500 のまま(余裕 3,569 バイト)。
    // (追記)Issue #397 R-6 の 2 つ目(日報と月報の一覧の取得・詳細の前半・先頭 7 項目を `getOkBody`・`fetchItemList`・`parseHeadOf` にまとめた): 224,931 → 224,062(-869。`pnpm run build:client` の出力〈「224062 バイト」〉。`Buffer.byteLength(CLIENT_JS)`)。R-6 全体で 226,589 → 224,062(-2,527)。上限は 228,500 のまま(余裕 4,438 バイト)。
    // (追記)Issue #400 R-11a(`createApp` の設定・起動・一括実行を `settings-screen.ts`・`run-control.ts`・`bulk-control.ts`・`keys.ts` へ切り出した。振る舞いは変えない): 224,062 → 224,891(+829。上限は 228,500 のまま。余裕 3,609 バイト)。
    // 内訳(`pnpm run build:client` の出力。各コミットの生成物の `Buffer.byteLength(CLIENT_JS)`): 設定の切り出し 224,062 → 224,408(+346)、起動・一括の切り出し 224,408 → 224,891(+483)。
    // 増えたのは、minify されないプロパティ名(戻り値の `enter`・`onInput`・`model`・`statesOf` ほか、deps のキー)と、`app.ts` が関数で渡す道具(`forceTrack` ほか)の分。
    // (追記)Issue #400 R-11b(`createApp` から読み込みと追跡を `race-data.ts` へ切り出した。振る舞いは変えない): 224,891 → 225,758(+867。上限は 228,500 のまま。余裕 2,742 バイト)。
    // 計り方: R-11a の公開時点(050ce5b)の生成物と今の生成物を、それぞれ import して `Buffer.byteLength(CLIENT_JS)` を取った(今の値は `pnpm run build:client` の出力)。ファイル別の内訳は測っていない。
    // 増えたのは、minify されないプロパティ名(`createRaceData` の戻り値 19 個の名前と、deps の 7 個のキー)と、`app.ts` が `data.` 経由で呼ぶ分。取得・追跡の本体は移しただけで増えていない。
    // (追記)Issue #389(#385-B の b): 内訳の節の数の上限 `parseBreakdown` を 8 から 16 に上げた(桁が 1 つ増えた分だけ): 225,758 → 225,759(+1。`pnpm run build:client` の出力〈「225759 バイト」〉)。節の文言はサーバが組み立てるので、クライアントの束は増えない。上限は 228,500 のまま(余裕 2,741 バイト)。
    // (追記)Issue #470(的中確率の下限): 設定画面に項目 `minHitProb`(ラベル・補助文・エラー文・並び)を足し、見送り理由の分類に below-min-hit-prob(core の文言 2 本と表示の対応表)を足した: 225,785 → 227,001(+1,216。`pnpm run build:client` の出力〈「227001 バイト」〉。
    // `Buffer.byteLength(CLIENT_JS)`。計り方: 変更前の生成物と今の生成物を、それぞれ文字列として取り出して測った)。上限は 228,500 のまま(余裕 1,499 バイト)。
    // (追記)Issue #481(検証画面の版別比較: いまの版だけを残し、過去の版は別のページ `#verify-versions` へ。分析 30 件未満の版は出さない): 227,001 → 228,489(+1,488。`pnpm run build:client` の出力〈「228489 バイト」〉。
    // `Buffer.byteLength(CLIENT_JS)`。計り方: 変更前〈9e57639〉の生成物と今の生成物を、それぞれ文字列として取り出して測った)。route の分岐・いまの版の一覧の読み取り・版の分け方と 30 件の境目・過去の版のページの見出しと文言(日本語は `\u` エスケープ)による増分。
    // 上限は 228,500 のまま(余裕 11 バイト)。**次にクライアントへ足すときは、先に束を減らすか、日本語の文をサーバが組み立てて渡す形(#379・#384 の流儀)にする**。
    // (追記)Issue #487(#481 の【記録】の回収): 228,489 → 228,400(-89。`pnpm run build:client` の出力〈「228400 バイト」〉。計り方は上と同じ)。版別カードが 30 件以上だけになって通らなくなった `MIN_RACES_FOR_BRIER` と「Brier: レース数不足」の枝を消し(-117)、
    // 過去の版のページの文言(節の見出しを両ページ共通の固定に・説明を分岐のない一文に・過去の版が無いときの文)を直した(+28)。上限は 228,500 のまま(余裕 100 バイト)。サーバが文を組み立てる形にしなかったのは、応答の読み取りが増えて束が減らないため。
    // (追記)Issue #509(#337-B1 の第 2 段階: 月報に「補正の当たり具合」の節): 上限を 228,500 から 230,500 へ引き上げた(メインの着手前ゲートの回答〈束の上限 A〉による)。228,400 → 228,883(+483。`pnpm run build:client` の出力〈「228883 バイト」〉。
    // `Buffer.byteLength(CLIENT_JS)`。計り方: 変更前〈de5c4a2〉の生成物と今の生成物を、それぞれ文字列として取り出して測った)。増えたのは、サーバが見出し・注・行の文字列まで作った節を読む `parseFit`(`api-monthly.ts`)、
    // 本文のモデルへの受け渡し(`monthly-model.ts`)、節を並べる 1 行(`view.ts`)だけ。日本語の文面は**サーバが組み立てる**(`adjustment-fit-format.ts`。#379・#384 の流儀)ので、束には 1 字も入っていない。
    // 着手前の見積もり(同じ形の仮実装を scratchpad のコピーで測った): +453。実測は +30 多かった(空の節で一覧を出さない分岐を足したため)。上限 228,500 には 383 バイト足りなかった。
    // 新しい上限 230,500 の根拠: 実測 228,883 に約 1.6KB の余裕(#362 の前例。228,883 + 1,617 を 500 バイト単位に切り上げ)。余裕は 1,617 バイト。
    // (追記)Issue #533(単勝・複勝の点数の上限の設定項目 2 つ): 上限は 230,500 のまま据え置き。228,883 → 230,369(+1,486。コミット済みの生成物と、`pnpm run build:client` で作り直した今の生成物を、それぞれ `Buffer.byteLength(CLIENT_JS)` で測った)。
    // 最初の文面では 230,849(上限を 349 超えた)だったので、補助文を短くし、入力の誤りの文言を 2 項目で 1 つにまとめて収めた(上限の引き上げはしていない)。余裕は 131 バイト。
    expect(Buffer.byteLength(CLIENT_JS)).toBeLessThan(230_500);
  });
});


/** クライアントが取り込んでよい core 側のモジュール(相対 import の指定子。拡張子なし)。`packages/core/src/view/`・`analysis/` の純関数だけ(もとは exe の renderer・shared。#286 で core へ移した)。#185 で配分の表示(`buildAllocationProposalView`)を流用するため。 */
const ALLOWED_EXTERNAL_IMPORTS = new Set([
  "../../packages/core/src/view/allocation-proposal-view",
  "../../packages/core/src/view/bet-allocation-view",
  "../../packages/core/src/view/format",
  // Issue #397(R-3): 検証画面の整形(率・金額・補正幅・各種ラベル)は、client に複製せず core の 1 本を直接 import する。**実行時の import を持たない**(型の import だけ)。
  // もとは `allocation-proposal-view`・`bet-allocation-view` の import で閉包に入っていた(`formatYen`)ので、束に入るモジュールは増えない。
  "../../packages/core/src/view/verify-format",
  "../../packages/core/src/analysis/analysis-types",
  // Issue #397(R-5): 小さな共通部品。client に複製していた定義(JST の計算・印の並び・型ガード)を core の 1 本に寄せたので、許可リストは**広がる**が、束に入る定義の数は増えない。
  // どれも**import を持たない**(`packages/core/test/common/` の単体テストと、`test/import-guard.test.ts` の閉包の検査が固定する)。`common/random.ts` は client から使わないので許可しない。
  "../../packages/core/src/common/jst",
  "../../packages/core/src/common/guards",
  "../../packages/core/src/common/prediction-marks",
  // Issue #189(設定画面): ラベルと版 ID は exe と共有していた定数(`packages/core/src/analysis/app-settings.ts`。import なしの純モジュール)、範囲の述語は cloud/src の純モジュール(サーバと同じ述語を使う)。
  "../../packages/core/src/analysis/app-settings",
  "../src/settings",
  // Issue #396: 設定画面のプロンプトのプレビューは**サーバが組み立てる**ので、クライアントは core の `build-prompt`(`@keiba/core/analyzer/build-prompt`)を import しない
  // (Issue #201 で入れていた「core を直接 import する例外」を外した。束から約 39 KB が減った)。下の「対照」と閉包の検査が、再び入ることを拒否する。
  // Issue #254(検証画面の対応表の信頼区間): Wilson 区間と判定(`wilsonInterval`・`judgeCalibration`)を、サーバ・テストと同じ実装で行うため。core を直接 import する例外(Issue #396 の後は、この 1 つだけ)
  // (上と同じ理由: `exports` の宣言済みサブパスで、**import が 1 つも無い**〈`node:`・`node_modules`・バレルが入らない〉モジュール。`packages/core/test/ev/binomial-interval.test.ts` が
  // import の無いことを、`native-free-modules.test.ts` が閉包を固定している)。
  "@keiba/core/ev/binomial-interval",
  // Issue #245: 回収率の表示(`formatRecoveryPercent`)。Discord の日報(Worker)と日報の画面が同じ丸めを使うため。**import を持たない**ことを下のテストが固定する。
  "../src/recovery-format",
  // Issue #247: 単勝の想定・実際のオッズの表示(丸め・「1000倍超」・ラベル・強調の判定・説明文)。Discord の通知(Worker)と馬のカードが同じ表示を使うため。**import を持たない**ことを下のテストが固定する。
  "../src/win-odds-format",
  // Issue #264: 見込みの的中数の表示(`formatExpectedHits`)。Discord の日報(Worker)と日報の画面が同じ書き方を使うため。**import を持たない**ことを下のテストが固定する。
  "../src/expected-format",
  // Issue #253: 複勝の想定・実際(下限〜上限)の表示(1.0倍未満・幅・上限なし・強調の判定・説明文)。Discord の通知(Worker)と馬のカードが同じ表示を使うため。取り込むのは `./win-odds-format`(上)だけで、下のテストが固定する。
  "../src/place-odds-format",
  // Issue #272: 日報の「もしも」の型の名前と成績の文(`templateLabel`・`formatTemplateStat`)。Discord の日報・LLM のプロンプト(Worker)と日報の画面が同じ書き方を使うため。取り込むのは `./recovery-format`(上)だけで、下のテストが固定する。
  "../src/whatif-format",
]);

function importAllowed(specifier: string): boolean {
  return specifier.startsWith("./") || ALLOWED_EXTERNAL_IMPORTS.has(specifier);
}

/** バンドルの入力(metafile)のうち、入れてはいけないもの: node_modules・バレル・better-sqlite3 に依存する core のモジュール・クライアントに入れない `packages/core/src/analysis/` の 4 本(旧 exe の main の共有部分)・Node の組込み。 */
function forbiddenInputs(inputs: readonly string[]): string[] {
  return inputs.filter(
    (f) =>
      /node_modules/.test(f) ||
      /packages\/core\/src\/index\.ts$/.test(f) ||
      /packages\/core\/src\/(?:ev\/analysis-store|scraper\/cache)\.ts$/.test(f) ||
      // Issue #287(#285 の段階B): 旧 `packages/app/src/main/` 全体の禁止の規則は、パッケージごと削除したので外した。
      // Issue #286(#285 の段階A): 旧 `packages/app/src/main/` の共有部分 4 本(analysis-pipeline・analysis-export・allocation-record・venue-codes)は
      // `packages/core/src/analysis/` へ移った。**「main の4本はクライアントに入れない」を、移設先の同じ4本で維持する**(同じ名前の `analysis-types`・`app-settings` などは、移設前も許可していた)。
      /packages\/core\/src\/analysis\/(?:analysis-pipeline|analysis-export|allocation-record|venue-codes)\.ts$/.test(f) ||
      /^node:/.test(f) ||
      /packages\/core\/src\/ev\/analysis-store-codec\.ts$/.test(f),
  );
}

/** 外から来た文字列を HTML・コードとして解釈させる API と、ブラウザで使えない Node の組込み。 */
const FORBIDDEN: readonly [string, RegExp][] = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /document\s*\.\s*write/],
  ["eval(", /\beval\s*\(/],
  ["new Function", /new\s+Function\b/],
  ["setAttribute('style')", /setAttribute\(\s*["']style["']/],
  ["node: の組込み", /["']node:/],
  ["require(", /\brequire\s*\(/],
  ["動的 import", /\bimport\s*\(/],
];

describe("静的ガード(クライアントのソースと生成物)", () => {
  it("ソース(コメントを除く)と生成物に、禁止の API が無い", () => {
    for (const file of clientFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      for (const [name, pattern] of FORBIDDEN) {
        expect(pattern.test(code), `${path.basename(file)} に ${name}`).toBe(false);
      }
    }
    for (const [name, pattern] of FORBIDDEN) {
      expect(pattern.test(CLIENT_JS), `生成物に ${name}`).toBe(false);
    }
  });

  it("対照: 検出の正規表現は、実際に書かれたときに拾える(空振りでない)", () => {
    const samples: Record<string, string> = {
      innerHTML: "el.innerHTML = x;",
      outerHTML: "el.outerHTML = x;",
      insertAdjacentHTML: "el.insertAdjacentHTML('beforeend', x);",
      "document.write": "document.write(x);",
      "eval(": "eval(x);",
      "new Function": "new Function('return 1');",
      "setAttribute('style')": "el.setAttribute('style', x);",
      "node: の組込み": 'import "node:fs";',
      "require(": "require('fs');",
      "動的 import": "import('./x.js');",
    };
    expect(Object.keys(samples).sort()).toEqual(FORBIDDEN.map(([n]) => n).sort());
    for (const [name, pattern] of FORBIDDEN) {
      expect(pattern.test(samples[name]!), name).toBe(true);
    }
  });

  it("クライアントの import は、client/ の中(`./`)と、許可リストの core の表示関数(`view/`・`analysis/`。もとは exe の renderer・shared)だけ(バレル・core の直接 import・node_modules・Node の組込みを取り込まない)", () => {
    let count = 0;
    let external = 0;
    for (const file of clientFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;"']*?\bfrom\s*["']([^"']+)["']/g)) {
        count += 1;
        const spec = m[1]!;
        if (!spec.startsWith("./")) external += 1;
        expect(importAllowed(spec), `${path.basename(file)} の import ${spec}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(5); // 前提: import を実際に拾えている
    expect(external, "前提: 表示関数(view/・analysis/)の import を実際に拾えている(0 だと許可リストの検査が空振り)").toBeGreaterThan(0);
  });

  it("対照: import の許可判定は、バレル・core の直接 import・bare specifier・許可外の表示関数・旧 exe のパスを拒否する(上の検査が空振りでない)", () => {
    for (const bad of ["@keiba/core", "@keiba/core/analyzer/build-prompt", "../src/prompt-preview", "../../packages/core/src/analyzer/build-prompt", "@keiba/core/ev/bet-allocation", "@keiba/core/analyzer/analyze-race", "@keiba/core/analyzer/build-prompt.js", "@keiba/core/ev/cloud-migration-format.js", "@keiba/core/ev/cloud-migration-format", "../src/migration-reader", "@keiba/core/ev/analysis-store", "../src/migration-core", "../src/migration-convert", "../src/migration-verify", "../src/migration-do", "@keiba/core/pipeline", "react", "node:fs", "../../packages/core/src/index", "../../packages/app/src/renderer/VerifyView", "../src/handler", "../../packages/core/src/analysis/analysis-export", "../../packages/core/src/common/random"]) {
      expect(importAllowed(bad), bad).toBe(false);
    }
    for (const good of ["./api", "../../packages/core/src/view/allocation-proposal-view", "../../packages/core/src/view/bet-allocation-view", "../../packages/core/src/view/format", "../../packages/core/src/view/verify-format", "../../packages/core/src/analysis/analysis-types", "../../packages/core/src/analysis/app-settings", "../src/settings", "../../packages/core/src/common/jst", "../../packages/core/src/common/guards", "../../packages/core/src/common/prediction-marks"]) {
      expect(importAllowed(good), good).toBe(true);
    }
  });

  it("バンドルの閉包(esbuild の metafile): core の表示関数(`view/`。もとは exe の renderer)の純関数が実際に入っており、node_modules・バレル・better-sqlite3 に依存するモジュール・Node の組込みは入っていない", async () => {
    const inputs = await listBundledInputs();
    expect(inputs.some((f) => f.endsWith("packages/core/src/view/allocation-proposal-view.ts")), "前提: 表示関数(view/)の流用が閉包に入っている").toBe(true);
    expect(inputs.some((f) => f.endsWith("packages/core/src/ev/combo-bet-allocation.ts")), "前提: core のサブパスが tsconfig の paths で解決されている").toBe(true);
    // Issue #396: プレビューの文面はサーバが組み立てるので、`buildPromptPreview` の閉包(build-prompt とその依存)はクライアントの束に入らない(Issue #201 で入れていたものを外した)。
    // 逆向きの固定: 1 つでも入ったら落ちる(束が約 39 KB 増える。`analyzer/` はプロンプト・脚質などサーバ側の部品)。
    for (const name of ["analyzer/build-prompt.ts", "analyzer/clip-variants.ts", "analyzer/leg-style.ts", "analyzer/day-baba.ts", "analyzer/condition-change.ts", "analyzer/early-position.ts", "scorer/derive-features.ts"]) {
      expect(inputs.some((f) => f.endsWith(`packages/core/src/${name}`)), `${name} は束に入らない`).toBe(false);
    }
    expect(inputs.some((f) => f.includes("packages/core/src/analyzer/")), "core の analyzer/ のモジュールは 1 つも束に入らない").toBe(false);
    expect(inputs.some((f) => f.endsWith("client/api-prompt-preview.ts")), "前提: 代わりに、サーバへ取りに行く API クライアントが入っている").toBe(true);
    expect(inputs.some((f) => f.endsWith("src/recovery-format.ts")), "前提: 回収率の表示(Issue #245)が閉包に入っている").toBe(true);
    expect(forbiddenInputs(inputs)).toEqual([]);
  }, 60_000);

  it("対照: 閉包の検査は、node_modules・バレル・better-sqlite3 に依存するモジュール・node: を拾える(空振りでない)", () => {
    const bad = [
      "../node_modules/cheerio/lib/index.js",
      "../packages/core/src/index.ts",
      "../packages/core/src/ev/analysis-store.ts",
      "../packages/core/src/scraper/cache.ts",
      "node:zlib",
      "../packages/core/src/analysis/analysis-export.ts",
    ];
    expect(forbiddenInputs([...bad, "../packages/core/src/ev/analysis-store-codec.ts"])).toEqual([...bad, "../packages/core/src/ev/analysis-store-codec.ts"]);
    expect(forbiddenInputs(["client/main.ts", "../packages/core/src/view/format.ts", "../packages/core/src/ev/bet-allocation.ts"])).toEqual([]);
  });
});

describe("日報の画面がクライアントに取り込む Worker 側のモジュール(Issue #245)", () => {
  it("recovery-format.ts は import を 1 つも持たない(Worker 専用のモジュール・node: を引き込まない)。クライアントの閉包に入っている", () => {
    const code = stripComments(readFileSync(path.join(ROOT, "cloud", "src", "recovery-format.ts"), "utf-8"));
    expect(code.length, "前提: 本体を読めている").toBeGreaterThan(300);
    expect(code.match(/(?:^|\n)\s*(?:import|export)\s+[^;]*?\bfrom\s*["'][^"']+["']/g) ?? []).toEqual([]);
    expect(/\brequire\s*\(|\bimport\s*\(/.test(code)).toBe(false);
    expect(importAllowed("../src/recovery-format")).toBe(true);
  });
});

describe("日報の画面がクライアントに取り込む Worker 側のモジュール(Issue #264)", () => {
  it("expected-format.ts は import を 1 つも持たない(Worker 専用のモジュール・node: を引き込まない)。クライアントの閉包に入っている", async () => {
    const code = stripComments(readFileSync(path.join(ROOT, "cloud", "src", "expected-format.ts"), "utf-8"));
    expect(code.length, "前提: 本体を読めている").toBeGreaterThan(200);
    expect(code.match(/(?:^|\n)\s*(?:import|export)\s+[^;]*?\bfrom\s*["'][^"']+["']/g) ?? []).toEqual([]);
    expect(/\brequire\s*\(|\bimport\s*\(/.test(code)).toBe(false);
    expect(importAllowed("../src/expected-format")).toBe(true);
    const inputs = await listBundledInputs();
    expect(inputs.some((f) => f.endsWith("src/expected-format.ts")), "前提: 見込みの表示が閉包に入っている").toBe(true);
  }, 60_000);
});

describe("馬のカードがクライアントに取り込む Worker 側のモジュール(Issue #247)", () => {
  it("win-odds-format.ts は import を 1 つも持たない(core の Plackett-Luce・Worker 専用のモジュール・node: を引き込まない)。クライアントの閉包に入っている", async () => {
    const code = stripComments(readFileSync(path.join(ROOT, "cloud", "src", "win-odds-format.ts"), "utf-8"));
    expect(code.length, "前提: 本体を読めている").toBeGreaterThan(300);
    expect(code.match(/(?:^|\n)\s*(?:import|export)\s+[^;]*?\bfrom\s*["'][^"']+["']/g) ?? []).toEqual([]);
    expect(/\brequire\s*\(|\bimport\s*\(/.test(code)).toBe(false);
    expect(importAllowed("../src/win-odds-format")).toBe(true);
    const inputs = await listBundledInputs();
    expect(inputs.some((f) => f.endsWith("src/win-odds-format.ts")), "前提: 単勝の想定の表示が閉包に入っている").toBe(true);
  }, 60_000);

  it("クライアントの束に Plackett-Luce(勝率の推定)が入っていない: 勝率の計算はサーバで行う(束の増加を抑える)。入ると、モデルの実行時の文言(エラーの文)が生成物に残る", () => {
    // 閉包(metafile)には combo-bet-allocation 経由で PL のファイルが載るが、使われないので tree-shaking で出力には残らない。クライアントが推定を呼ぶと、下の文言が出力に現れる。
    expect(CLIENT_JS).not.toContain("PLACKETT_LUCE_MODEL.");
    expect(CLIENT_JS).not.toContain("winProbabilitiesFromStrengths");
  });
});

describe("馬のカードがクライアントに取り込む Worker 側のモジュール(複勝。Issue #253)", () => {
  /** import / export-from の指定子(コメントを除いた本体から)。 */
  const importSpecifiers = (file: string): string[] =>
    [...stripComments(readFileSync(path.join(ROOT, "cloud", "src", file), "utf-8")).matchAll(/(?:^|\n)\s*(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!);

  it("place-odds-format.ts が取り込むのは `./win-odds-format`(import を持たない純モジュール)だけ。core の推定・Worker 専用のモジュール・node: を引き込まない。クライアントの閉包に入っている", async () => {
    const code = stripComments(readFileSync(path.join(ROOT, "cloud", "src", "place-odds-format.ts"), "utf-8"));
    expect(code.length, "前提: 本体を読めている").toBeGreaterThan(1000);
    expect(importSpecifiers("place-odds-format.ts")).toEqual(["./win-odds-format"]);
    expect(importSpecifiers("win-odds-format.ts"), "前提: 取り込み先は import を持たない").toEqual([]);
    expect(/\brequire\s*\(|\bimport\s*\(/.test(code)).toBe(false);
    expect(importAllowed("../src/place-odds-format")).toBe(true);
    const inputs = await listBundledInputs();
    expect(inputs.some((f) => f.endsWith("src/place-odds-format.ts")), "前提: 複勝の想定の表示が閉包に入っている").toBe(true);
  }, 60_000);

  it("クライアントの束に、複勝の想定の計算(core の推定・頭数の判定・API の整形)が入っていない: 計算はサーバで行う。閉包にも入っていない(単勝の推定 `win-odds-estimate.ts` は combo-bet-allocation 経由で閉包に載るが、使われないので出力には残らない)", async () => {
    const inputs = await listBundledInputs();
    for (const server of ["ev/place-odds-estimate.ts", "src/place-odds-view.ts", "src/analysis-view.ts"]) {
      expect(
        inputs.filter((f) => f.endsWith(server)),
        `${server} はクライアントの閉包に入れない`,
      ).toEqual([]);
    }
    expect(CLIENT_JS).not.toContain("PLACKETT_LUCE_MODEL.");
  }, 60_000);
});

describe("日報の画面がクライアントに取り込む Worker 側のモジュール(Issue #272)", () => {
  const importSpecifiers = (file: string): string[] =>
    [...stripComments(readFileSync(path.join(ROOT, "cloud", "src", file), "utf-8")).matchAll(/(?:^|\n)\s*(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!);

  it("whatif-format.ts が取り込むのは `./recovery-format`(import を持たない純モジュール)だけ。Worker 専用のモジュール(判定・集計)・node: を引き込まない。クライアントの閉包に入っている", async () => {
    const code = stripComments(readFileSync(path.join(ROOT, "cloud", "src", "whatif-format.ts"), "utf-8"));
    expect(code.length, "前提: 本体を読めている").toBeGreaterThan(500);
    expect(importSpecifiers("whatif-format.ts")).toEqual(["./recovery-format"]);
    expect(importSpecifiers("recovery-format.ts"), "前提: 取り込み先は import を持たない").toEqual([]);
    expect(/\brequire\s*\(|\bimport\s*\(/.test(code)).toBe(false);
    expect(importAllowed("../src/whatif-format")).toBe(true);
    const inputs = await listBundledInputs();
    expect(inputs.some((f) => f.endsWith("src/whatif-format.ts")), "前提: 型の表示が閉包に入っている").toBe(true);
    // 判定・集計(Worker 側の `daily-report-whatif.ts`・`daily-report-bets.ts`)は、クライアントの閉包に入れない
    for (const server of ["src/daily-report-whatif.ts", "src/daily-report-bets.ts", "src/daily-report-digest.ts"]) {
      expect(inputs.filter((f) => f.endsWith(server)), `${server} はクライアントの閉包に入れない`).toEqual([]);
    }
  }, 60_000);
});

describe("生成物の実行スモーク(偽の DOM・偽の fetch。node:vm)", () => {
  const FIXED = new Date("2026-06-28T00:00:00Z").getTime(); // JST 2026-06-28 09:00
  const DATE = "20260628";
  const RACE_ID = "202603020211";
  const ANALYSIS = {
    id: 5,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: DATE,
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", oddsStatus: "result", placeBasis: "top3" },
    horses: [{ umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null }],
    allocation: {
      route: "mixed", unavailableReason: null, fallbackReason: "no-combo-candidates", skipReasonCode: null, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1.1,
      includeComboOdds: true, includeWide: true, includeTrio: false, includeQuinella: null, includeExacta: true, includeTrifecta: false, includeBracketQuinella: null, betUnit: 100, oddsStatus: "result",
      bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 }],
    },
    detail: "present",
  };

  const SETTINGS = {
    evThreshold: 1, additionalInstruction: "", clipVariant: "default", analysisModel: "auto", bankroll: 500000, perRaceCap: 50000, kellyFraction: 0.5, minHitProb: 0.05, maxWinBetsPerRace: 2, maxPlaceBetsPerRace: 2, includeComboOdds: false,
    includeWideInAllocation: true, includeTrioInAllocation: true, includeQuinellaInAllocation: true, includeExactaInAllocation: true, includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true, preRaceOffsetMinutes: 45,
    // Issue #218・#353: スコアリングの重み15項目(既定値)
    biasWeightTrackCondition: 1, biasWeightVenue: 1, biasWeightSeason: 1, biasWeightFrame: 1, biasWeightSummerFatigue: 1, biasWeightTransport: 1, biasWeightRotation: 1,
    baseScoreWeightRecentForm: 0.2, baseScoreWeightLast3f: 0.1, baseScoreWeightCourseDistance: 0.15, baseScoreWeightJockey: 0.15, baseScoreWeightWeightChange: 1, baseScoreWeightCourseFrameBias: 1, baseScoreWeightTimeIndex: 0.12, baseScoreWeightTrainer: 0.77,
  };

  class FakeText {
    constructor(readonly data: string) {}
  }
  class FakeElement {
    readonly attrs = new Map<string, string>();
    readonly children: (FakeElement | FakeText)[] = [];
    readonly listeners = new Map<string, ((event: unknown) => void)[]>();
    value = "";
    checked: boolean | undefined = undefined;
    constructor(readonly tag: string) {}
    setAttribute(name: string, value: string): void {
      this.attrs.set(name, value);
    }
    appendChild(child: FakeElement | FakeText): void {
      this.children.push(child);
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
  }
  const flat = (n: FakeElement | FakeText): (FakeElement | FakeText)[] => (n instanceof FakeText ? [n] : [n, ...n.children.flatMap(flat)]);
  const textOf = (n: FakeElement | FakeText): string => flat(n).filter((x): x is FakeText => x instanceof FakeText).map((x) => x.data).join(" ");

  /** 条件が成り立つまで、I/O の 1 巡ずつ待つ(上限つき。実時間の待ちを使わない=CI で不安定にならない)。 */
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** 取得の後始末(マイクロタスク・I/O)を流す(上限つきの有限回)。 */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Issue #192: get-identity の応答(偽)。既定は 404(HTML が返った場合と同じく json() が失敗する)=メールアドレスのまま。 */
  type IdentityReply = { status: number; json: () => Promise<unknown> } | "network-error";
  const NOT_FOUND: IdentityReply = { status: 404, json: async () => { throw new SyntaxError("Unexpected token <"); } };

  /** `role`: `#app` の `data-role`(Issue #238。サーバが渡す)。既定は admin(従来のテストは管理者の画面を見る)。null は属性が無い場合(閲覧者に倒れる)。 */
  function run(initialHash = "", identityReply: IdentityReply = NOT_FOUND, role: string | null = "admin") {
    const root = {
      children: [] as (FakeElement | FakeText)[],
      replaced: 0,
      replaceChildren(...nodes: (FakeElement | FakeText)[]) { this.replaced += 1; this.children = nodes; },
      getAttribute: (name: string): string | null => (name === "data-role" ? role : null),
    };
    const listeners = new Map<string, (() => void)[]>();
    const calls: { url: string; init: { method?: string; credentials?: string; referrerPolicy?: string; body?: unknown; headers?: Record<string, string> } }[] = [];
    const location = { hash: initialHash };
    // Issue #192: get-identity の呼び出しは calls と別に数える(既存のテストが数える取得の本数に混ぜない)。表示の行は `.who .email`(偽の要素。textContent を持つ)。
    const identityCalls: { url: string; init: { method?: string; credentials?: string } }[] = [];
    const who = { textContent: "taro@example.com" as string | null };
    // 追跡のタイマー(偽。時間は進めない=張られた数だけを見る)と、可視状態(偽の document)。
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const documentListeners = new Map<string, (() => void)[]>();
    const doc = {
      visibilityState: "visible",
      getElementById: (id: string) => (id === "app" ? root : null),
      querySelector: (selector: string) => (selector === ".who .email" ? who : null),
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (t: string) => new FakeText(t),
      addEventListener: (type: string, fn: () => void) => void documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]),
    };
    const fetchStub = async (url: string, init: { method?: string; credentials?: string; referrerPolicy?: string; body?: unknown; headers?: Record<string, string> }) => {
      if (url === "/cdn-cgi/access/get-identity") {
        identityCalls.push({ url, init });
        if (identityReply === "network-error") throw new TypeError("Failed to fetch");
        return identityReply;
      }
      calls.push({ url, init });
      if (init.method === "POST" && url === "/api/analyses/run") {
        const body = JSON.parse(init.body as string) as { race_id: string; kaisai_date: string; mode: string };
        return { status: 202, json: async () => ({ ok: true, accepted: true, race_id: body.race_id, kaisai_date: body.kaisai_date, mode: body.mode, status: "queued" }) };
      }
      if (url === "/api/settings") {
        // Issue #189: 設定の取得(GET)と保存(POST は受けた本文をそのまま返す)
        const settings = init.method === "POST" ? JSON.parse(init.body as string) : SETTINGS;
        return { status: 200, json: async () => (init.method === "POST" ? { ok: true, settings } : { ok: true, settings, source: "d1" }) };
      }
      if (url === "/api/settings/prompt-preview") {
        // Issue #396: プレビューの文面はサーバが組み立てる。偽のサーバは、受けた本文を実際のサーバの関数(`buildPreviewText`)に通して返す。
        const body = JSON.parse(init.body as string) as { additionalInstruction: string; clipVariant: string };
        return { status: 200, json: async () => ({ ok: true, ...buildPreviewText(body) }) };
      }
      if (url.startsWith("/api/races")) {
        return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, venue: "central", races: [{ race_id: "202603020211", venue_name: "福島", race_number: 11, race_name: "福島民報杯", course_type: "芝", distance: 1800, entry_count: 16, grade: null }] }) };
      }
      if (url === `/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`) {
        return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, races: [{ race_id: RACE_ID, mode: "morning", status: "done", attempts: 1, error: null, queued_at: 1, updated_at: 2, prior: true, analysis_id: null, detail: null, children_ok: null }], prior: { race_name: "福島民報杯", venue_name: "福島", date: "2026-06-28", computed_at: 5, rows: [{ rank: 1, umaban: 3, horse_name: "アルファ", prior: 0.523 }] } }) };
      }
      if (url.startsWith("/api/analyses?race_id=")) {
        return { status: 200, json: async () => ({ ok: true, analyses: [] }) };
      }
      if (url === "/api/analyses/5") {
        return { status: 200, json: async () => ({ ok: true, analysis: ANALYSIS }) };
      }
      return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, races: [] }) };
    };
    class FixedDate extends Date {
      constructor(...args: unknown[]) {
        super(...((args.length === 0 ? [FIXED] : args) as [number]));
      }
      static override now(): number {
        return FIXED;
      }
    }
    const context = {
      document: doc,
      setTimeout: (fn: () => void) => {
        timerId += 1;
        timers.set(timerId, fn);
        return timerId;
      },
      clearTimeout: (id: number) => void timers.delete(id),
      window: { addEventListener: (type: string, fn: () => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
      location,
      fetch: fetchStub,
      Date: FixedDate,
      URLSearchParams,
      Promise,
      console,
    };
    vm.runInNewContext(CLIENT_JS, context);
    return { root, listeners, calls, location, timers, doc, documentListeners, identityCalls, who };
  }

  it("Issue #192: ロード時に get-identity を 1 回だけ呼び(GET・同じオリジンの資格情報)、name を「ログイン中」の行(`.who .email`)の textContent に入れる。メールアドレスはどこにも残らない", async () => {
    const { who, identityCalls } = run("", { status: 200, json: async () => ({ name: "テスト 太郎", email: "taro@example.com" }) });
    await until(() => who.textContent !== "taro@example.com");
    expect(who.textContent).toBe("テスト 太郎");
    expect(identityCalls).toHaveLength(1);
    expect(identityCalls[0]!.init.method).toBe("GET");
    expect(identityCalls[0]!.init.credentials).toBe("same-origin");
  });

  it.each([
    ["404(HTML が返る)", NOT_FOUND],
    ["ネットワークエラー", "network-error" as const],
    ["name が空", { status: 200, json: async () => ({ name: "" }) }],
    ["name が無い", { status: 200, json: async () => ({ email: "taro@example.com" }) }],
  ] as [string, IdentityReply][])("Issue #192: get-identity が %s のときは、メールアドレスのまま(例外にならず、画面の描画も続く)", async (_label, reply) => {
    const { who, identityCalls, root, calls } = run("", reply);
    await until(() => identityCalls.length >= 1 && calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    await settle();
    expect(identityCalls).toHaveLength(1); // 前提: 呼ばれた(呼ばれていなければ、メールのままは自明)
    expect(who.textContent).toBe("taro@example.com");
    expect(root.children.some((c) => textOf(c).includes("福島民報杯"))).toBe(true);
  });

  it("Issue #192: ハッシュの遷移・「更新」・設定画面への遷移でも、get-identity は呼ばれない(1 回だけ)", async () => {
    const { listeners, location, identityCalls, calls, root } = run("", { status: 200, json: async () => ({ name: "テスト 太郎" }) });
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    await settle();
    expect(identityCalls).toHaveLength(1);
    location.hash = "#settings";
    listeners.get("hashchange")![0]!();
    await settle();
    location.hash = "";
    listeners.get("hashchange")![0]!();
    await settle();
    expect(identityCalls).toHaveLength(1);
  });

  it("ロードで例外にならず、今日(JST)の一覧と板を 1 回ずつ取り(GET・同じオリジンの資格情報)、描画する。hashchange を購読する。ハッシュを書き換えない", async () => {
    const { root, listeners, calls, location } = run();
    await until(() => calls.length >= 2 && root.children.length > 0 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    expect(calls.map((c) => c.url).sort()).toEqual([`/api/analyses/status?kaisai_date=${DATE}`, `/api/races?kaisai_date=${DATE}&venue=central`].sort());
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.credentials).toBe("same-origin");
      expect(call.init.body).toBeUndefined();
    }
    expect(root.children).toHaveLength(1);
    expect(textOf(root.children[0]!)).toContain("福島民報杯");
    expect((listeners.get("hashchange") ?? []).length).toBe(1);
    expect(location.hash).toBe("");
  });

  // Issue #238: 役割(サーバが `#app` の `data-role` で渡す)が、生成物の実行(main.ts の配線)で効く。閲覧者・属性なし・未知の値は、管理者の入口を出さず、管理者だけの画面では取得しない。
  const linkClasses = (root: { children: (FakeElement | FakeText)[] }): string[] =>
    root.children.flatMap(flat).filter((n): n is FakeElement => n instanceof FakeElement && n.tag === "a").map((n) => n.attrs.get("class") ?? "");

  it("Issue #238: 管理者(data-role=admin)の一覧には「検証」「設定」「日報」の入口が出る(対照)", async () => {
    const { root, calls } = run("", NOT_FOUND, "admin");
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    expect(linkClasses(root)).toEqual(expect.arrayContaining(["verify-link", "report-link", "settings-link"]));
  });

  it.each([
    ["viewer", "viewer"],
    ["属性なし", null],
    ["未知の値", "root"],
    ["大文字の ADMIN(完全一致でない)", "ADMIN"],
  ] as [string, string | null][])("Issue #238: data-role が %s のとき、一覧に「設定」の入口が出ない(日報は出る。検証の入口は Issue #263 で閲覧者にも出す)", async (_label, role) => {
    const { root, calls } = run("", NOT_FOUND, role);
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    const classes = linkClasses(root);
    expect(classes).toContain("report-link"); // 前提: 一覧が描画されている
    expect(classes).toContain("verify-link");
    expect(classes).not.toContain("settings-link");
  });

  it.each([["設定", "#settings"]])("Issue #238: 閲覧者が %s の画面(%s)を直接開いても、API を取らず「管理者だけが使えます」を出す(生成物の実行)", async (_label, hash) => {
    const { root, calls } = run(hash, NOT_FOUND, "viewer");
    await until(() => root.children.some((c) => textOf(c).includes("管理者だけが使えます")));
    await settle();
    expect(root.children.some((c) => textOf(c).includes("管理者だけが使えます"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("Issue #263: 閲覧者が検証の画面(#verify)を開くと、GET /api/verify?venue=all を 1 回だけ取る(refresh は付けない)。「管理者だけが使えます」は出ず、更新ボタンが無い。管理者には更新ボタンがある(生成物の実行)", async () => {
    const buttonClasses = (root: { children: (FakeElement | FakeText)[] }): string[] =>
      root.children.flatMap(flat).filter((n): n is FakeElement => n instanceof FakeElement && n.tag === "button").map((n) => n.attrs.get("class") ?? "");
    const viewer = run("#verify", NOT_FOUND, "viewer");
    await until(() => viewer.calls.length >= 1 && viewer.root.children.some((c) => textOf(c).includes("検証")));
    await settle();
    expect(viewer.calls.map((c) => c.url)).toEqual(["/api/verify?venue=all"]);
    expect(viewer.root.children.some((c) => textOf(c).includes("管理者だけが使えます"))).toBe(false);
    expect(buttonClasses(viewer.root)).toContain("verify-venue"); // 前提: 検証の画面が描画されている
    expect(buttonClasses(viewer.root)).not.toContain("refresh");
    const admin = run("#verify", NOT_FOUND, "admin");
    await until(() => admin.calls.length >= 1 && admin.root.children.some((c) => textOf(c).includes("検証")));
    await settle();
    expect(buttonClasses(admin.root)).toContain("refresh");
  });

  it("Issue #238: レース画面は、管理者には起動のボタンが 2 つ、閲覧者には 0 個(生成物の実行)", async () => {
    const buttonsOf = async (role: string): Promise<number> => {
      const { root, calls } = run(`#date=${DATE}&venue=central&race=${RACE_ID}`, NOT_FOUND, role);
      await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("事前分析")));
      await settle();
      return root.children.flatMap(flat).filter((n): n is FakeElement => n instanceof FakeElement && n.tag === "button" && (n.attrs.get("class") ?? "") === "run").length;
    };
    expect(await buttonsOf("admin")).toBe(2);
    expect(await buttonsOf("viewer")).toBe(0);
  });

  it("同じ状態の再描画(同じハッシュの hashchange)では DOM を触らない(Issue #186 段階1。createMounter が main.ts に配線されている)", async () => {
    const { root, listeners, calls } = run();
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    await settle(); // 取得の後始末の再描画を待つ
    const settled = root.replaced;
    const shown = root.children[0];
    expect(settled).toBeGreaterThanOrEqual(1);
    expect((listeners.get("hashchange") ?? []).length).toBe(1); // 前提: hashchange を購読している
    listeners.get("hashchange")![0]!();
    listeners.get("hashchange")![0]!();
    expect(root.replaced).toBe(settled);
    expect(root.children[0]).toBe(shown);
  });

  it("「更新」を連打しても、取得は 1 回分(一覧と板で 2 本)だけ増える。起動のボタンを押さない限り POST は呼ばれない", async () => {
    const { root, calls } = run();
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    const before = calls.length;
    const refresh = flat(root.children[0]!).find((n): n is FakeElement => n instanceof FakeElement && n.tag === "button")!;
    const click = refresh.listeners.get("click")![0]!;
    click(undefined);
    click(undefined);
    click(undefined);
    await until(() => calls.length >= before + 2);
    await settle();
    expect(calls.length).toBe(before + 2);
    expect(calls.filter((c) => c.init.method !== "GET")).toEqual([]);
  });

  it("Issue #189: 設定画面(#settings): GET /api/settings だけを取り、33 個の入力欄(既存の 18〈Issue #470 で的中確率の下限、Issue #533 で単勝・複勝の点数の上限を足した〉+ スコアリングの重み 15。textarea・select・checkbox を含む)を描画する。入力して保存すると、DOM のイベントの値が 32 項目の POST になる(一覧・板は取らない)", async () => {
    const { root, calls } = run("#settings");
    await until(() => root.children.some((c) => flat(c).some((n) => n instanceof FakeElement && n.attrs.has("data-field"))));
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["GET /api/settings"]);
    const fields = flat(root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && n.attrs.has("data-field"));
    expect(fields.length).toBe(33);
    expect(fields.map((n) => n.tag).sort()).toEqual([...Array(7).fill("input"), "input", "input", "input", "input", "input", "input", "input", "input", ...Array(15).fill("input"), "select", "select", "textarea"].sort()); // select は クリップ幅と分析モデルの2つ(Issue #158)。重み15項目は input(Issue #218・#353)
    const field = (key: string) => fields.find((n) => n.attrs.get("data-field") === key)!;
    expect(field("bankroll").value).toBe("500000");
    expect(field("clipVariant").value).toBe("default"); // select は option を入れたあとに value が設定される
    expect(field("analysisModel").value).toBe("auto"); // Issue #158: 分析モデルも select(既定 auto)
    expect(field("includeWideInAllocation").checked).toBe(true);
    expect(field("includeComboOdds").checked).toBeFalsy();
    field("bankroll").listeners.get("change")![0]!({ target: { value: "123456" } });
    field("analysisModel").listeners.get("change")![0]!({ target: { value: "opus" } });
    field("includeComboOdds").listeners.get("change")![0]!({ target: { value: "on", checked: true } });
    field("biasWeightVenue").listeners.get("input")![0]!({ target: { value: "0.75" } }); // Issue #218: 重みの欄(生成物の実行)
    const save = flat(root.children[0]!).find((n): n is FakeElement => n instanceof FakeElement && n.attrs.get("class") === "settings-save")!;
    save.listeners.get("click")![0]!(undefined);
    await until(() => calls.some((c) => c.init.method === "POST"));
    const post = calls.find((c) => c.init.method === "POST")!;
    expect(post.url).toBe("/api/settings");
    expect(post.init.referrerPolicy).toBe("same-origin");
    expect(JSON.parse(post.init.body as string)).toEqual({ ...SETTINGS, bankroll: 123456, includeComboOdds: true, analysisModel: "opus", biasWeightVenue: 0.75 });
    await until(() => root.children.some((c) => textOf(c).includes("保存しました")));
  });

  it("Issue #201・#396: 設定画面のプロンプトのプレビュー(生成物の実行): 開くと、サーバ(偽のサーバは実際の buildPreviewText)が組み立てた文面(【予想印】・サンプルレース)が、打った追加指示つきで出る。通信は GET /api/settings と POST /api/settings/prompt-preview 1 回だけ。閉じると消える", async () => {
    const { root, calls } = run("#settings");
    const elements = () => flat(root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement);
    await until(() => root.children.some((c) => flat(c).some((n) => n instanceof FakeElement && n.attrs.has("data-field"))));
    const toggleOf = () => elements().find((n) => n.attrs.get("class") === "preview-toggle")!;
    expect(toggleOf().attrs.get("aria-expanded")).toBe("false");
    expect(elements().some((n) => n.attrs.get("class") === "prompt-preview")).toBe(false); // 前提: 開くまで文面は無い
    const area = elements().find((n) => n.attrs.get("data-field") === "additionalInstruction")!;
    area.listeners.get("input")![0]!({ target: { value: "スモークの追加指示" } });
    toggleOf().listeners.get("click")![0]!(undefined);
    await until(() => calls.some((c) => c.url === "/api/settings/prompt-preview"));
    await until(() => textOf(elements().find((n) => n.attrs.get("class") === "prompt-preview")!).includes("【予想印】"));
    const body = elements().find((n) => n.attrs.get("class") === "prompt-preview");
    expect(body, "開くと文面が出る").toBeDefined();
    const text = textOf(body!);
    expect(text).toContain("サンプルレース(プレビュー用)");
    expect(text).toContain("【予想印】");
    expect(text).toContain("±10%(絶対値0.10)");
    expect(text).toContain("スモークの追加指示");
    expect(toggleOf().attrs.get("aria-expanded")).toBe("true");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["GET /api/settings", "POST /api/settings/prompt-preview"]);
    const sent = calls.find((c) => c.url === "/api/settings/prompt-preview")!;
    expect(sent.init.credentials).toBe("same-origin");
    expect(sent.init.referrerPolicy).toBe("same-origin");
    expect(JSON.parse(sent.init.body as string)).toEqual({ additionalInstruction: "スモークの追加指示", clipVariant: "default" });
    toggleOf().listeners.get("click")![0]!(undefined);
    expect(elements().some((n) => n.attrs.get("class") === "prompt-preview")).toBe(false);
  });

  it("Issue #394: 移行画面は廃止した(生成物の実行): 設定画面に #migration へのリンクが無く、`#migration` を開いても /api/migration は取らない", async () => {
    const settings = run("#settings");
    await until(() => settings.root.children.some((c) => flat(c).some((n) => n instanceof FakeElement && n.attrs.has("data-field"))));
    expect(flat(settings.root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && String(n.attrs.get("class") ?? "").startsWith("migration"))).toEqual([]);
    expect(flat(settings.root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && n.attrs.get("href") === "#migration")).toEqual([]);
    expect(settings.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["GET /api/settings"]);
    const migration = run("#migration");
    await until(() => migration.root.children.length > 0);
    expect(migration.calls.some((c) => c.url.includes("/api/migration"))).toBe(false);
  });

  it("レース画面(#…&race=): 状態(race_id つき)と過去の分析の 2 本だけを取り、カードと朝の prior を描画する。一覧・板・分析の詳細・POST は呼ばない", async () => {
    const { root, calls } = run(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await until(() => root.children.some((c) => textOf(c).includes("アルファ")));
    expect(calls.map((c) => c.url).sort()).toEqual([`/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`, `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`].sort());
    expect(calls.filter((c) => c.init.method !== "GET")).toEqual([]);
    const text = textOf(root.children[0]!);
    expect(text).toContain("事前分析");
    expect(text).toContain("発走前");
    expect(text).toContain("3着内率 52.3%");
  });

  it("起動のボタン(生成物の実行): 押すと POST が 1 回(同じオリジンの資格情報・referrerPolicy: same-origin・fetch の mode なし)出て、「待ち」になり、追跡のタイマーが張られる。非表示でタイマーが止まる", async () => {
    const { root, calls, timers, doc, documentListeners } = run(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await until(() => root.children.some((c) => textOf(c).includes("アルファ")));
    expect((documentListeners.get("visibilitychange") ?? []).length).toBe(1); // 可視状態を購読している
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(0); // 前提: 押すまで POST は無い
    expect(timers.size).toBe(0); // 前提: 実行中の行が無いので追跡していない
    const buttons = flat(root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && n.tag === "button" && n.attrs.get("data-mode") === "pre_race");
    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0]!)).toBe("発走前の分析を実行");
    expect(buttons[0]!.attrs.get("data-race")).toBe(RACE_ID);
    buttons[0]!.listeners.get("click")![0]!(undefined);
    buttons[0]!.listeners.get("click")![0]!(undefined); // 二重押し
    await until(() => calls.some((c) => c.init.method === "POST"));
    await settle();
    const posts = calls.filter((c) => c.init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/analyses/run");
    expect(JSON.parse(posts[0]!.init.body as string)).toEqual({ race_id: RACE_ID, kaisai_date: DATE, mode: "pre_race" });
    expect(posts[0]!.init.credentials).toBe("same-origin");
    expect(posts[0]!.init.referrerPolicy).toBe("same-origin");
    expect(Object.keys(posts[0]!.init)).not.toContain("mode"); // fetch の mode は入れない
    const after = flat(root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && n.tag === "button" && n.attrs.get("data-mode") === "pre_race")[0]!;
    expect(textOf(after)).toBe("待ち");
    expect(timers.size).toBe(1); // 追跡のタイマー
    doc.visibilityState = "hidden";
    documentListeners.get("visibilitychange")![0]!();
    expect(timers.size).toBe(0); // 非表示で止まる
  });

  it("結果画面(#analysis=): /api/analyses/{id} を 1 回だけ取り、馬のカードと配分(core の表示関数〈`view/`。もとは exe の renderer〉の純関数を、Node の組込みの無い環境で実行)を描画する", async () => {
    const { root, calls } = run("#analysis=5");
    await until(() => root.children.some((c) => textOf(c).includes("配分の提案")));
    expect(calls.map((c) => c.url)).toEqual(["/api/analyses/5"]);
    const text = textOf(root.children[0]!);
    expect(text).toContain("福島11R テストステークス");
    expect(text).toContain("3着内率 20.0%");
    expect(text).toContain("組合せ券種にEVプラスの候補が無かったため複勝のみの配分になっています。"); // fallbackReason が exe の注記になる
    expect(text).toContain("300円");
    expect(text).not.toContain("AI補正後");
  });
});
