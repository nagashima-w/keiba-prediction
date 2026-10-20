/**
 * runAnalysis の golden JSON を生成する(Issue #176〈#164-a〉AC-a1)。
 *
 * 使い方: `pnpm tsx scripts/gen-pipeline-golden.ts`(リポジトリルートで)。
 * 出力: `packages/core/test/golden/pipeline-golden.json`。
 *
 * **golden は、runAnalysis を変更する前のコミット(b821c97〈v1.19.9〉)で生成した。** 変更後のコードで再生成して
 * 差分が出たら、それは exe の出力が変わったことを意味する(意図した変更でない限り golden を更新してはいけない)。
 * **Issue #250 で一度だけ再生成した**: スナップショットの race にグレード(`grade`)を足したため、G3 のレース(ラジオNIKKEI賞)の
 * raceSnapshot.race に `"grade": "G3"` が加わった(差分はその 3 か所のみ。`git diff` で確認済み)。
 * **Issue #295 で再生成した**(`PROMPT_VERSION` が "2026-10-13.1" → "2026-10-13.2" になった): 差分は LLM のシナリオの `record.promptVersion` の 1 行のみ(プロンプト本文・スナップショットは、当日の馬場の値が無いので不変)。
 * **Issue #315 で再生成した**(`PROMPT_VERSION` が "2026-10-13.2" → "2026-10-15.1" になった): 差分は LLM のシナリオの `record.promptVersion` の 1 行と、`promptText`(プロンプトの全文。展開想定から規則の結論を外し、各馬の行にテンの位置を足し、指示・出力スキーマを足した)の 1 行だけ(`git diff` で確認済み)。スナップショット・確率・配分は不変。
 * **Issue #296 で再生成した**: 組合せの配分を計算した 2 シナリオ(`noLlmAllBets`・`llmStubSameDayGrade`)の `record.raceSnapshot` に `comboStats`(券種ごとの EV プラスの点数)が加わった(差分はその 2 か所の追加 52 行のみ。削除行なし。`git diff` で確認済み)。
 * **Issue #311 で再生成した**: スナップショットの馬にスタート直後の位置(`earlyPos`)を足したため、3 シナリオの `record.raceSnapshot.horses` の各馬に `"earlyPos": <数または null>` の行が加わった(差分は追加 48 行のみ・削除行なし。`git diff --stat` と、追加行がすべて `earlyPos` の行であることを `git diff | grep '^[-+]'` で確認済み)。
 * **Issue #329 で再生成した**: 印を全消しにする旧経路の `marksDropped`・`marksDroppedReason` を `AnalysisResult` から削除したため、3 シナリオの `result` から該当の 2 行ずつが消えた(差分は削除 6 行のみ・追加行なし。`git diff --stat` と `git diff | grep '^[-+]'` で確認済み)。
 * **Issue #339 で再生成した**(既定の重みを当て直した: 近走着順 0.2→0.7・上がり3F 0.1→0.15・コース距離 0.15→0.30・バイアスの一律減衰 0.3→0.05。`PROMPT_VERSION` が "2026-10-15.1" → "2026-10-16.1" になった): 差分は、(1) LLM のシナリオの `record.promptVersion` の 1 行、(2) `promptText`(プロンプトの全文)の 15 行(各馬の「3着内率=」と「参考EV=」の数字だけ。数字以外は同一)、(3) 3 シナリオの全 16 頭の `prior`・`adjustedProb`・`ev`(`result.rows` と `record.horses`)と `promptInput.horses` の `prior`・`referenceEv`、(4) 寄与度の `weight`(各 160 個。基礎 3 項目とバイアス 7 項目)・`correction`・`differenceCorrection`、(5) 配分(`record.allocation.bets` の `ev`・`odds`・`stake` と、EV の順に並ぶ買い目の `betType`・`comboKey`、買い目の数 278→289〈noLlmAllBets〉・283→289〈llmStubSameDayGrade〉)と `comboStats` の `positive`(EV プラスの点数)。キーの追加・削除、数値以外・prior と配分に関わらない項目の変化は無い(新旧の JSON を構造で比べて確認済み)。
 * **Issue #353 で再生成した**(タイム指数を統計モデルの 14 番目の項目に入れた: 重み既定 0.12。`PROMPT_VERSION` が "2026-10-16.1" → "2026-10-18.1" になった)。差分の検査(作業用のスクリプトで実施):
 *   (a) タイム指数の重みを 0 にして再計算すると、旧 golden と(各馬の寄与度の末尾の 14 番目と、版の文字列を除いて)完全に一致する。
 *   (b) 重み 0.12 との差は、prior・adjustedProb・ev・referenceEv・配分の買い目の数・組合せの EV プラス数・各馬の寄与度の 14 番目(重みと補正)・promptText の各馬の「3着内率=」の数字だけ。
 *       promptText は、数字を伏せると全行が重み 0 のものと同一(文面は不変)。
 * **Issue #354 で再生成した**(調教師の前2年の3着内率を統計モデルの 15 番目の項目に入れた: 重み既定 0.77。`PROMPT_VERSION` が "2026-10-18.1" → "2026-10-18.2" になった)。差分は 2 種類のみ:
 *   (a) 各馬の寄与度の末尾に 15 番目の「調教師成績」が加わる(シナリオには調教師の成績を載せていないので、全頭 applied:false・補正 0・重み 0.77)。prior・確率・EV・配分は不変。
 *   (b) LLM のシナリオの `record.promptVersion` の 1 行。
 *   差分の検算: 旧 golden と新 golden を構造で比べ、新しい側の寄与度配列から末尾の 1 件を除き `promptVersion` を戻すと完全に一致する(追加された 15 番目は 48 件、それ以外の差は promptVersion の 1 件だけ)。
 * **Issue #363 で再生成した**: スナップショットの馬に終盤の位置(`latePos`)を足したため、3 シナリオの `record.raceSnapshot.horses` の各馬に `"latePos": <数または null>` の行が加わった。
 *   差分の検査: `git diff -U0 packages/core/test/golden | grep '^[-+]'` で、追加 48 行がすべて `"latePos"` の行で、削除行は 0(`grep -c '"earlyPos"'` も `grep -c '"latePos"'` も 48)。
 * **Issue #400 R-10b で再生成した**(開催日の近似の経路を撤去: `AnalysisResult.dateApproximate` を削除し、3 件目のシナリオを `noLlmNoAllocationNoDate`〈開催日なし〉から `noLlmNoAllocation`〈開催日あり〉へ改名した)。
 *   差分の検査: 新旧の JSON を構造で比べ、(a) 3 シナリオの `result.dateApproximate` の行が消える、(b) 3 件目の `record.kaisaiDate` が null から "20260628" になる、(c) 3 件目のシナリオ名、の 3 点だけであること。
 * **Issue #421 段階 1 で再生成した**(スナップショットの race にレースの条件〈負担重量の種別・牝馬限定〉を足した。入力の出馬表 `shutuba_202603020211` はハンデ戦で牝馬限定でない)。
 *   差分の検査: 新旧の JSON を構造で比べ、差分が「3 シナリオの `record.raceSnapshot.race` に `weightType: "ハンデ"` と `filliesOnly: false` の 2 キーが加わる」6 件だけで、
 *   `promptInput`・`promptText`・確率・配分・その他のキーは 1 件も動かない(`git diff` の行としては、`"grade": "G3"` の末尾のカンマが加わる 3 行を含む 12 行)。
 * 入力はすべてリポジトリ内のフィクスチャと固定の合成値(実ネットワーク・実 API には触れない。時刻は固定)。
 * 検証は `packages/core/test/analysis/analysis-pipeline-golden.test.ts`。
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeGolden } from "../packages/core/test/golden/pipeline-golden-scenarios.js";

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "core",
  "test",
  "golden",
  "pipeline-golden.json",
);

const golden = await computeGolden();
writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`, "utf-8");
console.log(`wrote ${OUT}`);
