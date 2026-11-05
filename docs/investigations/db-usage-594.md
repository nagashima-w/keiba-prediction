# D1・DO の SQL の洗い出しと、伸び続ける表の見積もり(Issue #612。親は #594)

調査日は 2026-11-05(JST)。コードは work-612(57e4a66c から)で、**コードは直していない**。本番の D1 には SELECT だけを流した(書き込み・DDL は流していない)。
本番の数字は、Cloudflare の API(D1 の SELECT と GraphQL)で取った。再現できない数字は書かず、再現の手段をこの文書の末尾と `db-usage-594/` に置いた。

## 0. 結論

### 0.1 先に押さえること

- **いまの D1 の読み取りは、無料枠(1 日 500 万行)の 1〜8% に収まっている。** #597・#600 の公開後の 1 日は、コード由来の読み取り(診断の SQL を除く)が 6 万〜41 万行と見込める(§2.3)。急ぐ理由は無い。
- ただし、**表が増えると読み取りも比例して増える全走査が 5 つある**(§6 の上位 5 件)。そのうち 1 つ(検証の再計算)は、1 年後に 1 日の上限(20 回)まで使うと無料枠を超える。もう 1 つ(変換 DO の目録の走査)は、**取得と変換が終わる 1〜2 週間後には今の 8 倍近く**(1.8 万 → 13.8 万行/晩)になる。
- **Issue の「D1 の容量 5 GB」は、無料枠では当てはまらない。** 無料枠の上限は **1 DB あたり 500 MB**(`docs/current-spec.md` の「クラウド版の D1 の容量の見積もり」。コードの `DB_SIZE_LIMIT_BYTES` は余裕を見て 400 MB)。5 GB はアカウント全体の合計。1 年後の見積もりは 500 MB に対して書いた(§5)。
- **整合検査(`RECONCILE_RACE_BACKFILL_SQL`)が、本番で一度も走った形跡が無い**(§7)。#597 の公開後、夜の窓は 11/5 の 01:00 JST の 1 回だけあったが、D1 の SQL 別の集計に該当の SQL が現れない。失敗が握られているか、そこに届いていないかは、ログを見るまで分からない。
- 結果の補完の `excludedIds` は、**1 晩に 7 表ぶんを全部読む**(`backfill_race` 4 回・`backfill_class` 2 回・`backfill_payout` 1 回)。表は補完の積み残しを消化する間だけ増え、**積み残しが無くなれば増えない**。DO の読み取りの上限(無料枠 1 日 500 万行)に対しては 0.15% で、優先度は低い(§4.2)。

### 0.2 直す候補の上位 5 件(効き目の大きい順)

「効き目」は、1 日の読み取りが減る量。並べる基準は、**1 年後(B のペース。§5)の見込み**を主にして、いまの値を添えた。

| 順 | SQL(場所) | 1 回の読み取り(根拠) | いまの 1 日 | 1 年後(B)の 1 日 | 直し方 | 書き込みの増え方 |
|---|---|---|---|---|---|---|
| 1 | 検証の再計算 `VERIFY_READ_SQL` 7 本 + `VERIFY_CLOSE_READ_SQL` 2 本(`verify-read.ts`・`verify-close.ts`。`D1VerifyStore.readAll`) | **70,624 行**(全表を読む。合成データ。§3.3) | 実測の最大は 10/11 の約 30.8 万行(その日の読み取りの 70%。馬の全件読みが 10 回)。1 日の上限は 20 回 = 141 万行 | 1 回 約 33 万行。20 回で 660 万行(**無料枠を超える**) | **まず設定**: `VERIFY_DAILY_LIMIT` を 20 → 6 程度に下げる(上限が 1 年後でも 200 万行に収まる)。**次に SQL**: 開催日ごとに読み、変わった開催日だけ読み直す(1 開催日 約 600 行〔24 分析の日。§3.3〕)。核の `computeVerifyReport` が全件を前提にしているので、中間結果を DO の kv に開催日別に持つ設計変更が要る | D1 は 0。kv に開催日別の中間結果(1 日 数 KB)を書く |
| 2 | 変換 DO の目録の走査 `SELECT_CATALOG_PAGE_SQL`(`race-archive-repository.ts`。呼び元は `race-archive-runs-core.ts` の `step`) | 100 行/ページ。**1 周 = 目録の全行**。変換が終わると、窓(01:00〜08:30 JST)の間、**1 時間おきに 1 周**(01:00〜08:00 の 8 周/晩) | 11/4(UTC)に 337 回・31,147 行 | 取得の完了後は 8 周 × 約 1.7 万行 = 約 13.8 万行/晩。1 年後は約 16.6 万行/晩 | **索引で直す**: 部分索引 `ON race_archive (race_id) WHERE runs_version IS NULL` を足し、未変換だけを `WHERE runs_version IS NULL AND race_id > ? ORDER BY race_id LIMIT ?` で引く。計測: 全部変換済みで 1 行、30 件が未変換で 30 行(現行は 100 行/ページで、1 周が目録の全行) | 索引の行が、レース 1 件につき +2(入る +1・変換で消える +1)。取得の完了までに約 3.5 万行、以後は年に約 7 千行。10 万行/日の中 |
| 3 | 整合検査 `RECONCILE_RACE_BACKFILL_SQL`(`race-backfill-state.ts`。呼び元は `result-backfill-core.ts` の `reconcileTonight`。夜に 1 回) | **30,318 行**(分析 + 結果の全部。合成データ)。本番の移行の初期投入が同じ SELECT で 1 回 30,092 行 | 30,000 行/夜(**本番で走った形跡が無い**。§7) | 約 13 万行/夜 | **SQL の書き換え**: 直近 14 日の開催日のレースに絞る(`raceBackfillStateSelect` の `analysesWhere`・`resultsWhere` に開催日の範囲を渡す)。計測: 96 レースで 2,305 行(**−92%**)。全件の検査は月に 1 回にする | 0(ずれが無ければ) |
| 4 | 期間集計 `READ_PERIOD_SQL` 6 本(`daily-report-repository.ts`。日報の 28 日累計と月報) | 6 文の合計で 1 回 12,781 行(28 日・合成データ)。本番の実測は 1 回 約 3 万行(2.7〜3.4 万) | 8,000〜175,000 行(10/31〜11/3 の 4 日の実測) | 約 2 倍(窓の中の分析数に比例) | **SQL の書き換え**: 1 文目で最新の分析 ID とレース ID を取り、残り 5 文は `json_each` で引く(今は 6 文それぞれが `ROW_NUMBER()` の CTE を作り直す)。計測: 12,781 → 8,738 行(**−32%**) | 0 |
| 5 | `FILL_WIN_ODDS_SQL`・`FILL_SCRATCHED_SQL`・`FILL_WIN_PAYOUT_SQL`(`result-repository.ts`) | 14 頭で **239 行**(馬の数 n の 2 乗で増える)。直すと **15 行**(−94%) | 約 2.6 万行(10/31〜11/4 の 5 日で 19,000〜34,000 行/日)。補完の積み残しが消化中のぶんを含む | 新しい結果の取り込みのぶんだけ。36〜45 レース/日 × 177 行 = 0.6〜0.8 万行 | **SQL の書き換え**: 馬番をキーにしたオブジェクトの JSON を束縛し、`json_extract(?1, '$."' \|\| umaban \|\| '"[0]')` で引く(`race_results` の `race_id = ?` の行だけを読む)。3 本とも同じ形 | 0(書き換わる行は同じ) |

いまは、検証の再計算を除いて、どれも 1 日 2〜4 万行規模で、**単独で急ぐものは無い**。順位は「放っておくと増える量」で付けた。

### 0.3 1 年後に問題になりそうな表

| 表 | いま → 1 年後(B。A〜C は §5) | 何が問題か |
|---|---|---|
| `horse_runs`(D1) | 5.0 万行 → 33 万行(29〜51 万)。約 100 MB | 過去の結果の取得(#549)が 5 年ぶんを埋めるため、**D1 全体の増分の半分以上**。管理者の status(`readHorseRunsStatus`)が 3 文 × 全行 × 2 で、いま 30 万行/回 → **約 200 万行/回**になる |
| `analysis_horses`・`race_results`(D1) | 3.3 万行 → 14 万行、2.1 万行 → 9.2 万行 | 検証の再計算(上の 1 位)の読み取りの約 8 割を占める |
| `race_archive`(D1) | 2,264 行 → 約 2.1 万行 | 変換 DO の走査(上の 2 位)の読み取りに直結 |
| D1 の容量 | 33 MB → 約 185 MB(140〜370 MB) | 500 MB に対して 28〜74%。自前の上限 400 MB(取得と変換を止める)に届くのは、全レースを分析する C のペースで約 1.1 年後 |
| DO の日ごとの `RaceDay` | 1 日 1 インスタンス。表は消えない | 大きさは**測れなかった**(§5.3)。1 年で約 120 開催日 |

## 1. 調べ方と、数字の信頼度

| 数字の種類 | どう取ったか | 信頼度 |
|---|---|---|
| 本番の行数 | D1 の API で `SELECT COUNT(*)` を表ごとに 1 回(27 表) | 実測。2026-11-05 12:00 JST ごろ |
| 本番の SQL ごとの回数・読み取り行数 | GraphQL `d1QueriesAdaptiveGroups`(30 日分。`db-usage-594/fetch-d1-queries.py`。結果の集計は `prod-d1-queries-30d.tsv`) | 実測。日付は UTC 日(JST の 09:00〜翌 09:00) |
| DO の読み取り・書き込み | GraphQL `durableObjectsPeriodicGroups`(時間ごと。名前空間 ID は `GET /workers/durable_objects/namespaces` で名前に引いた) | 実測 |
| 1 回あたりの読み取り(「合成データ」と書いたもの) | ローカルの D1(workerd)に、本番の行数と同じ規模の合成データを作り、`meta.rows_read` を測った(`db-usage-594/measure.test.ts.txt`。結果は `measure-result.json`) | **規模だけ本番に合わせた計測**。日付・馬数の分布は一様で、本番とは違う。本番の値と照合できたもの: `CLASS_DISTRIBUTION` 5,025(本番 5,034)、整合検査 30,318(本番の同じ SELECT 30,092)、`FILL_WIN_ODDS` 239(14 頭。本番の平均 177 は 12〜13 頭のレースと idempotent の呼び出しを含む)、`horse_runs` の診断 100,116(本番 98,444 ÷ 2 回 = 49,222 = 行数 24,611 の 2 倍) |
| EXPLAIN QUERY PLAN | `cloud/migrations` 35 本を当てた空の SQLite(`node:sqlite`)。本番に `sqlite_stat1` は無い(`sqlite_master` を確認)ので、統計なしの計画で一致する | 計画の形は信頼できる |
| 呼ばれる SQL の一覧 | `cloud/test/local-bindings.ts` の `db.prepare` を一時的に包んで SQL を記録し(`record-sql.patch`)、`openLocalBindings` を使う cloud のテスト 60 ファイルを流した(929 件通過・1 件失敗。失敗は `fetch failed` の通信エラーで、この調査と無関係)。記録は 50,650 行、本番のコード由来の型に絞って 169 型、うち EXPLAIN できたのは 167 型(`explain-plans.txt`) | コードを読んだ結果と突き合わせた。テストで通らない経路は、コードを読んで補った |
| 1 年後の見積もり | §5 の前提(伸び方 3 通り・1 行の大きさの概算) | **概算(±30%)**。D1 の実際の大きさ 33.4 MB に対し、同じ式で今を見積もると 31.7 MB |
| DO の SQLite の読み取り回数 | 実際の `ResultBackfillCore` を本物のローカル D1 とつないで 1 晩を回し、`excludedIds` の SQL を数えた(`sim-excluded-ids.test.ts.txt`。結果は `sim-excluded-ids-result.json`) | 回数は実測(シミュレーション)。行数は表の行数の仮定(§4.2) |

**注意**: 2026-11-05(UTC)の D1 の読み取りの約 24 万行は、この調査自身の読み取り(`COUNT(*)` と標本の SELECT)。日別の表からは除いて読むこと。

## 2. 本番の規模と直近の実測

### 2.1 D1 の行数(2026-11-05)

D1 の大きさは 33,406,976 バイト。

| 表 | 行数 | 表 | 行数 |
|---|---:|---|---:|
| `horse_runs` | 50,058 | `race_backfill` | 1,605 |
| `analysis_horses` | 33,348 | `race_result_meta` | 1,522 |
| `race_results` | 20,911 | `analysis_allocation_meta` | 885 |
| `race_combo_payouts` | 4,927 | `kaisai_days` | 532 |
| `race_combo_payout_imports` | 3,416 | `analysis_close` | 416 |
| `analyses` | 2,524 | `trainer_names` | 268 |
| `race_archive` | 2,264 | `jockey_results` | 220 |
| `analysis_close_bets` | 2,044 | `horse_run_saves` | 213 |
| `analysis_bets` | 1,756 | `jockey_names`・`trainer_results` | 189・189 |
| `race_conditions` | 120 | `daily_reports` | 15 |
| `baba_conditions`・`baba_fetches`・`baba_fetch_attempts` | 13・6・6 | `r2_ops`・`monthly_reports`・`cloud_settings` | 2・1・1 |

`horse_runs` の内訳(1 回の GROUP BY): `source` が NULL(分析時に保存)が 25,634 行、`source = 'result'`(過去の結果の変換)が 24,424 行。後者は 2026 年のレースだけ。`race_archive` 2,264 件が全部変換済みなら 1 レースあたり 10.8 行(変換印の書き込みが 11/4 に 2,280 行あるので、ほぼ全件と見ている。件数の確認はしていない)。

### 2.2 D1 の日別の読み取り・書き込み(UTC 日)

| UTC 日 | 読み取り | 書き込み | メモ |
|---|---:|---:|---|
| 10/29 | 309,673 | 507 | |
| 10/30 | 412,865 | 2,726 | |
| 10/31 | 341,803 | 7,256 | |
| 11/1 | 1,260,218 | 6,114 | `horse_runs` の診断 9.8 万、期間集計 17.5 万、旧い列挙 55.8 万 |
| 11/2 | 774,585 | 2,811 | 旧い列挙 77.4 万 |
| 11/3 | 1,490,237 | 5,553 | 旧い列挙 73.3 万、診断の SQL 69.6 万 |
| 11/4 | 396,380 | 29,529 | 過去の結果の変換(`horse_runs` の書き込み)。#597 の公開(11/4 12:40 UTC)の後 |

書き込みの最大は 29,529 行(11/4)で、無料枠の 10 万行/日の 3 割。変換の 1 晩の上限(`ARCHIVE_RUNS_NIGHTLY_ROWS_DEFAULT` = 30,000 行)が効いている。

### 2.3 30 日の読み取りの内訳

10/6〜11/5(31 日)の合計は 14,343,093 行(1 日あたり約 46 万行)。種類別:

| 種類 | 読み取り | 割合 |
|---|---:|---:|
| 旧い補完の列挙(`WITH u AS …`。#597 で置換済み) | 8,200,612 | 57.2% |
| 旧い検証の未確定の一覧(`COUNT(*) OVER () AS total`。#600 の索引の前) | 913,559 | 6.4% |
| `FILL_WIN_ODDS`(3,539 回。1 回平均 200 行) | 707,047 | 4.9% |
| `horse_runs` の診断(管理者の status と、その場の診断 SQL) | 715,938 | 5.0% |
| 期間集計(`WITH latest …`) | 674,676 | 4.7% |
| 検証の再計算(馬の全件読みだけ) | 583,652 | 4.1% |
| `FILL_SCRATCHED`・`FILL_WIN_PAYOUT` | 69,813 | 0.5% |
| `horse_runs` の書き込み・書き換え | 131,750 | 0.9% |
| コード外(診断 SQL・移行・旧版) | 1,013,728 | 7.1% |
| その他の現行コード | 1,332,318 | 9.3% |

**#597・#600 で置き換わった形が 63.6%** を占めていた。残りを、公開後の 1 日に直すと次の見込み。

| 日 | コード由来(全部) | うち置換済みの形 | 置換後の見込み | コード外 |
|---|---:|---:|---:|---:|
| 10/31 | 419,288 | 249,000 | 約 17 万 | 2,303 |
| 11/1 | 965,602 | 558,000 | 約 41 万 | 247,322 |
| 11/2 | 833,350 | 774,000 | 約 6 万 | 34,548 |
| 11/3 | 869,469 | 733,000 | 約 14 万 | 696,219 |

(「置換済みの形」は千の位で丸めた。日別・SQL 別の元の値は `prod-d1-queries-30d.tsv` を日で分けて再集計する。)

**実測との突き合わせ**: 公開後の 11/4(UTC)は、日別の表で 396,380 行(SQL 別の集計の合計は 410,361 行で、3.5% ずれる。集計の元が違う)。内訳(SQL 別): 現行コード 154,341 行(`horse_runs` の書き換え 8.0 万・書き込み 2.7 万、`FILL_WIN_ODDS` 2.6 万、`race_backfill` の作り直し 1.2 万、`FILL_WIN_PAYOUT` 0.6 万ほか)と、コードの文字列と一致しない 256,020 行(移行 0035 の初期投入 6.0 万、目録の読み 3.1 万〔SQL を動的に組み立てるので一致しない。現行コード〕、診断の SQL 約 16.5 万)。上の見込み(置換後の現行コード 6〜41 万)と矛盾しない。

「コード外」の列は、診断の SQL・移行・旧版に加えて、動的に組み立てるためにコードの文字列と一致しなかった現行コードの SQL(目録の読み)を含む。

### 2.4 DO の読み取り(UTC 日、行)

| 名前空間 | 10/29 | 10/30 | 10/31 | 11/1 | 11/2 | 11/3 | 11/4 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `RaceDay`(日ごと) | 23,191 | 50,609 | 144,108 | 128,605 | 59,065 | 36,472 | 25,371 |
| `ResultBackfill` | 50,743 | 67,958 | 42,998 | 101,658 | 91,279 | 89,917 | 15,952 |
| `NetkeibaGate` | 480 | 1,902 | 3,546 | 2,862 | 1,983 | 15,546 | 471 |
| `RaceArchiveFetchDO` | 0 | 0 | 0 | 18 | 0 | **5,517,912** | 10,970 |
| `RaceArchiveRunsDO` | 0 | 0 | 0 | 0 | 0 | 0 | 13,420 |

- **11/3(UTC)の `RaceArchiveFetchDO` は 5.5M 行で、無料枠の DO の 1 日 500 万行を超えている**。#593(索引 2 本と 1 晩の予算)の前の最初の晩(コミット ba3cbd7d は 11/3 19:46 UTC)。公開後の 11/4 は 1.1 万行、11/5(07:00 UTC の窓の分)は 5,282 行に収まった。
- DO の書き込みは 7 日で `RaceDay` 15,909・`NetkeibaGate` 19,093・`RaceArchiveFetchDO` 15,290・`ResultBackfill` 2,583。
- `VerifyReportDO` は SQL を持たず(kv だけ)、読み取りは出ない。

## 3. D1 の SQL

### 3.1 一覧の取り方

`cloud/src` で `prepare(` を含む行は 156、ファイルは 22(`git grep -n 'prepare(' cloud/src | wc -l`・`git grep -l … | wc -l`。コメント内の記述を含む)。動的に組み立てる SQL(`listStatements`・`verifyDayAllocationSql`・`targetsSql`・`readStored` の IN 句など)があるので、**実際に流れた SQL を記録して EXPLAIN にかけた**(§1)。結果は `explain-plans.txt`(167 型。`注意:` の行が全走査・一時の並べ替え・自動索引・2 乗のループ)。

### 3.2 全走査(SCAN)と `USE TEMP B-TREE` の一覧

「小さい表」は、本番の行数が 500 行未満の表。「主キーの範囲」は索引を使った範囲読み。

**表の全部を読むもの(設計どおり)**

| SQL | 表の行数 | 呼ばれ方 | 所見 |
|---|---:|---|---|
| `VERIFY_READ_SQL` 7 本・`VERIFY_CLOSE_READ_SQL` 2 本 | 計 70,624 | 検証の再計算(最短 5 分・上限 20 回/日・TTL 1 時間) | §6 の 1 位 |
| `RECONCILE_RACE_BACKFILL_SQL`(`analyses` と `race_results` を GROUP BY) | 計 約 2.4 万 | 結果の補完の DO、夜に 1 回 | §6 の 3 位。結合に自動索引(`AUTOMATIC COVERING INDEX`)を作る |
| `CLASS_DISTRIBUTION_SQL`(`analyses` を `race_class` で GROUP BY + `COUNT(DISTINCT)` + ORDER BY) | 2,524 | 補完の status を開くたび(管理者の口) | 5,025 行/回(行数の 2 倍。一時 B-TREE が 3 つ)。1 年後 B は約 2.1 万行/回 |
| `readHorseRunsStatus` の 3 文(`horse_runs` を GROUP BY。`json_extract`) | 50,058 | 管理者の `/api/horse-runs`(画面は自動で呼ばない) | 各 100,116 行(行数の 2 倍)、計 約 30 万行/回 |
| `CANDIDATES_SQL`(`analyses` 全件 + `race_results` の EXISTS) | 2,524 | 統計モデルの書き出し・配分の書き出し(管理者の要求) | 4,965 行/回 |
| `LOOKUPS_SQL`・`TRAINER_LOOKUPS_SQL`(騎手名・調教師名の GROUP BY) | 189・268 | 統計モデルの書き出し | 小さい表 |
| 日報・月報の一覧(`daily_reports`・`monthly_reports`。`ORDER BY` の主キー順 + LIMIT) | 15・1 | 一覧の画面 | 主キーの索引順で足りる |
| `baba_fetches` の一覧(主キー順 + LIMIT 14) | 6 | 馬場の status | 小さい表 |

**一時の並べ替え(`USE TEMP B-TREE`)だけのもの(範囲が日付・ID で絞られている)**

| SQL | 範囲 | 呼ばれ方 |
|---|---|---|
| `PENDING_SQL`(`COUNT(*) OVER ()`) | 部分索引 `idx_analyses_pending` の未確定の行 | 検証画面の GET ごと。#600 で索引化済み。**未確定の行を全部読む**(`LIMIT` が `COUNT OVER` の後に効くため)。読む行数は未確定の件数(補完が済めば 0) |
| `LIST_UNIMPORTED_SQL`・`LIST_UNIMPORTED_BY_DAY_SQL` | 窓(31 日)の分析 | cron(21:00・23:00 JST)と手動の取り込み。339〜343 行/回 |
| `LIST_DAY_ANALYSES_SQL`・`TARGETS_ANALYSES_SQL`・`LAST_DAY_STATUS_SQL` | 1 日の分析(`idx_analyses_kaisai_date`) | 日報・今日の狙い目・月報。25〜270 行/回 |
| `READ_PERIOD_SQL` 6 本(`ROW_NUMBER() OVER (PARTITION BY race_id …)`) | 期間(28 日・1 か月)の分析 | §6 の 4 位 |
| `listStatements` の馬(`ORDER BY analysis_id DESC, umaban`) | 一覧の 50 件 | 一覧。1,450 行/回(馬 650 行 + 索引) |
| `FIT_CANDIDATES_SQL` | 月の分析 | 月報の補正の当たり具合。577 行/回 |
| 馬場の期間読み 2 本(`SAVED_SQL`・`ATTEMPTS_SQL`) | 小さい表 | 馬場の status |

**行数の 2 乗で読むもの(意図していない)**

| SQL | 形 | 計測 |
|---|---|---|
| `FILL_WIN_ODDS_SQL`・`FILL_SCRATCHED_SQL`・`FILL_WIN_PAYOUT_SQL`(`UPDATE race_results … FROM (SELECT … FROM json_each(?)) j`) | プランが「`SEARCH race_results (race_id=?)` が外側、`SCAN json_each` が内側」になる。`race_id = ?` で絞った 14 行それぞれに対して、`json_each` の 14 要素を舐める | 14 頭で 239 行。`WHERE` が `race_results` の列だけで先に落ちる `FILL_SCRATCHED`・`FILL_WIN_PAYOUT` は、対象が無い呼び出しでは 14 行で済む(本番の平均 14・28 行)。`FILL_WIN_ODDS` の `WHERE` は `j.o` を含むので落とせず、**本番の平均 177 行** |

**それ以外**(索引を使っていて問題が無いもの): `analyses` の `race_id`・`kaisai_date`・`prompt_version` の引き、`analysis_horses`・`analysis_bets`・`race_results` などの `IN (SELECT value FROM json_each(?))`(主キーの索引を引く)、`horse_runs` の `horse_id IN (…)`(主キー)、`race_backfill` の列挙(`idx_race_backfill_st1〜4` の部分索引。1 行/回)。

### 3.3 SQL ごとの呼ばれ方と読み取り(1 回 × 回数)

「計測」はローカルの合成データ(§1)、「本番」は GraphQL の実測。

**結果の補完・取り込み(`result-repository.ts`)**

| SQL | 呼ばれ方 | 1 回の読み取り | 1 日の見込み |
|---|---|---|---|
| 馬ごとの UPSERT(`UPSERT_RESULTS_JSON_SQL`) | 結果の取り込みの batch の中(1 レース 1 回) | 本番 12 行/回(76 回 925 行) | 36 レースで 0.4 千行 |
| `FILL_WIN_ODDS_SQL` | 同じ batch の 6 文目(新規の取り込み)と、補完の段階 2 | 計測 239(14 頭)、本番平均 177 | 実測 1.9〜3.4 万(129〜173 回/日。10/31〜11/4) |
| `FILL_SCRATCHED_SQL`・`FILL_WIN_PAYOUT_SQL` | 補完の段階 2・4 | 本番平均 14・28 | 実測 1〜2 千・4〜6 千 |
| `SAVE_RACE_CLASS_SQL` | 補完の段階 3 | 本番 2.8 | 実測 0.3 千 |
| `RECOMPUTE_RACES_SQL`(`race_backfill` の作り直し) | 書き込みの batch の末尾(結果・オッズ・払戻・クラス・**分析の保存**) | 計測 25(1 レース)。本番 23 | 11/4 に 501 回・11.5k |
| `RECOMPUTE_BY_ANALYSIS_IDS_SQL` | 検証の補完 tick(1 回 30 分析) | 計測 928 | 補完中だけ |
| `RECONCILE_RACE_BACKFILL_SQL` | 補完 DO、夜に 1 回 | 計測 30,318 | **本番で未観測**(§7) |
| `LIST_*_BACKFILL_SQL`(4 本)・`COUNT_*_BACKFILL_SQL`(4 本) | 補完 DO の列挙(1 晩 4 回)・status | 本番 1 行/回(`LIST_WIN_ODDS` 28 回 28 行)。計測 0〜316 | <1 千 |
| `settleRaceBackfillSql`(`UPDATE race_backfill SET stN = 2 …`) | 補完 DO の済みの写し(500 ID/文) | 計測 1,501(500 ID。1 ID あたり 3 行) | 本番 14 回・770 行 |
| `LIST_UNIMPORTED_BY_DAY_SQL` | cron(21:00・23:00 JST の retry)と手動 | 計測 343。本番 7 回・973 行(139/回) | 0.3 千 |
| `getRaceResultDetails`(結果・面の 2 文) | 当日傾向(`runAnalysis`) | 計測 612(36 レース。約 17 行/レース)。本番 60 回・4,427 行(74/回) | 数百〜数千 |
| 統計モデルの書き出しの結果読み(`prior-export-store.ts` の `RESULTS_SQL`) | 書き出しの要求(管理者) | 本番 73 回・34,110 行(467/回) | 書き出した日だけ(10/30・11/3 に 1.6〜1.8 万) |

**分析(`analysis-repository.ts`)**

| SQL | 呼ばれ方 | 1 回の読み取り | 1 日の見込み |
|---|---|---|---|
| `saveAnalysis` の batch(約 9 文) | 分析 1 件ごと(書き込み) | 本番: 馬の INSERT 27 行/回、`r2_ops` の SELECT 1 行 + UPSERT、`RECOMPUTE` 23 行 → 約 60〜80 行/件 | 24〜37 件/日で 2 千 |
| 一覧 `listAnalysisSummaries`(分析 + 馬の 2 文) | `GET /api/analyses`。画面は `race_id`・`kaisai_date`・`limit=20` つきで、レース画面を開くたび | 計測: 絞り込みなし 50 件で 1,500、`kaisai_date` で 25、`race_id` で 3 | 数百〜数千 |
| 詳細 `getAnalysisDetail`・`getStoredAllocation` | 詳細を開くたび | 計測 1+14+(1〜3)+3 | 数十/回 |
| `listRecentForRace`・`listAnalyzedRaceIdsByPromptVersion` | 重複の確認・版別 | `idx_analyses_race_analyzed`・`idx_analyses_prompt_version_race` を使う(カバリング) | 小 |
| 締切の再計算の保存 `saveClose`(UPSERT + DELETE + INSERT の batch) | 再計算ごと(1 分析 2 回) | 本番 `analysis_close_bets` の INSERT 8 行/回 | 小 |
| `r2_ops`(SELECT・UPSERT) | R2 の読み書きごと | 1 行/回。本番 11/3 に 4,455 回(archive 取得の保存ごと) | 4 千 |

**検証(`verify-store.ts`)**

| SQL | 呼ばれ方 | 1 回の読み取り |
|---|---|---|
| `WATERMARK_SQL`・`PENDING_SQL` | `/api/verify` の管理者の要求ごと(閲覧者は kv だけ) | 4 行 + 未確定の行数(索引後) |
| `readAll`(9 本) | 再計算(最短 5 分間隔・20 回/日・TTL 1 時間・透かしが変われば) | **計測 70,624**(分析 2,524・馬 33,348・配分メタ 885・買い目 1,756・結果 21,308・組合せ払戻 4,927・取込印 3,416・再計算 416 + 2,044) |
| `COMMIT_SQL`・`RECOMPUTE_BY_ANALYSIS_IDS_SQL` | 補完 tick(アラーム。1 秒間隔で最大 40 クエリ) | 数百 |

**日報・月報・今日の狙い目**

| SQL | 呼ばれ方 | 1 回の読み取り |
|---|---|---|
| `NEEDING_REPORT_SQL` | cron(23:00 JST の retry) | 計測 169。本番 7 回・361 行 |
| `LIST_DAY_ANALYSES_SQL` + `READ_RESULTS_SQL` 3 本 | 日報の DO の実行ごと | 計測 49 + 612(36 レース) |
| `READ_PERIOD_SQL` 6 本 | 日報の 28 日累計・月報 | 計測 12,781(28 日)・14,605(1 か月)。**本番 1 回 約 3.3 万**(10/31〜11/3 の 4 日で 1.4〜5.3 回/日) |
| `LAST_DAY_STATUS_SQL` | 月報の cron 待ちのたび | 計測 268 |
| `TARGETS_*`(6 文)・`VERIFY_DAY_*`(5 文。収支の途中経過) | `GET /api/targets`(画面を開く + **3 分ごとの自動の取り直し**。最大 120 回/6 時間) | 計測 約 1,800(24 分析の日)。コードの予算は 5,000 + 5,000。本番の 10/29〜11/5(約 8 日)の合計は約 4 万行(297 文) |

**周辺**

| SQL | 呼ばれ方 | 1 回の読み取り |
|---|---|---|
| `horse_runs` の読み(`READ_SQL_HEAD`。`horse_id IN (…)`) | 分析 1 件ごと(14 頭) | 計測 56(8 頭)。**取得の完了後は 1 頭あたりの履歴が増える** |
| `horse_runs` の書き込み(`INSERT … DO NOTHING`・`UPDATE … DO UPDATE`・`REWRITE_RESULT_SQL`) | 分析時の保存・過去の結果の変換 | 本番 INSERT 263/回、REWRITE 521/回(100 要素の `json_each`) |
| `race_archive` の保存(`SELECT_R2_USAGE_SQL`・`SELECT 1`・UPSERT) | 取得の 1 件ごと | 本番 11/3 に `SELECT 1` が 2,327 回(1 行/回) |
| 目録 `listCatalogPage`・`getCatalogEntry` | 変換 DO・取得 DO | 100 行/ページ(§6 の 2 位) |
| `jockey_results`・`trainer_results` の読み(`IN (?, …)`)・UPSERT | 分析の前(騎手・調教師の成績) | 本番 約 25 行/回(267 回 6,692 行・207 回 5,215 行) |
| `kaisai_days`・`race_conditions`・`jockey_names`・`trainer_names`・`baba_*` | 分析の前後・馬場の取得 | 計測 0〜数行(`SCAN` は小さい表) |
| `cloud_settings`(`SELECT settings_json … WHERE id = 1`) | 設定を使う要求ごと | 1 行/回。7 日で 162 回 |
| `d1-health` の probe | `/api/health` | 5 行/回 |

## 4. Durable Object の SQLite

### 4.1 DO ごとの SQL と、全部を読むもの

| DO | 表 | 全部を読む SQL(`EXPLAIN` は `do-explain.mjs`) | 備考 |
|---|---|---|---|
| `ResultBackfill` | `backfill_meta`・`backfill_race`・`backfill_class`・`backfill_payout` | `excludedIds`(`WHERE last_night = ?`。**索引なしの SCAN**)、`collectSettled`(6 文。`WHERE state = …`)、status(`GROUP BY last_class`・`COUNT(*) WHERE state …` の 7 文) | §4.2 |
| `RaceArchiveFetchDO` | `ra_meta`・`ra_month`・`ra_day`・`ra_race` | `ra_month` の選択(約 61 行の SCAN)。ほかは索引(`ra_race_status_date`・`ra_day_status_date`)で足りる。status は `SELECT COUNT(*) FROM ra_race WHERE status = ?` を 5〜6 本(索引だけ。**完了済みの行数ぶん**読む) | 1 晩の予算 100 万行(`ARCHIVE_NIGHTLY_ROWS_LIMIT`)。公開後の 1 起床は約 80 行 |
| `RaceArchiveRunsDO` | `rr_meta`・`rr_fail`・`rr_reject` | `rr_fail` の COUNT 2 本(SCAN)、`rr_reject` の GROUP BY(SCAN)。どちらも status だけ | 失敗・拒否のレースだけを持つ |
| `RaceDay`(日ごと) | `race_day_meta`・`race_day_tasks`・`race_day_morning_prior`・`race_day_plan(_venue)`・`race_day_close(_input)`・`race_day_result`・`race_day_notify`・取得キャッシュ(`fetch_cache`)ほか | 次の仕事の選択(`ORDER BY (mode = 'pre_race') DESC, …`。SCAN + 一時 B-TREE)、`COUNT(*) WHERE status IN (…)`。表は 1 日ぶん(レース × 2 モード) | 7 日で 46.7 万行。10/31 の 14.4 万行が最大 |
| `NetkeibaGate` | kv のみ(`SELECT 1 + 1` の確認だけ) | なし | 7 日で 2.7 万行 |
| `VerifyReportDO`・`DailyReportDO`・`MonthlyReportDO`・`PriorExportDO`・`AllocationExportDO` | kv のみ(SQL は D1 へ) | なし | 読み取りはほぼ 0 |

### 4.2 結果の補完の `excludedIds`(`backfill_race`・`backfill_class`・`backfill_payout`)

`excludedIds(night, kind)` は、**その晩に試したレースを列挙から外すため**、段階に応じた表の `last_night = 今夜` の行を全部読む。`last_night` に索引は無い。

**いつ・何回**: 列挙は段階に入った最初のステップで 1 回(`listAndDispatch` → `listUnimportedRacesByDay` のコールバック)。待ち行列(#598)が空で、まだ列挙していないか、最後の列挙が要求ちょうどを返したときだけ、もう一度流れる。段階は `results` → `win-odds` → `race-class` → `win-payout` の 4 つで、読む表は 1・1・2・3 表。シミュレーション(段階 4 の積み残し 540 レース・3 表に済みの行が 1,100・1,000・1,000)の 1 晩の結果:

- `excludedIds` の SELECT は **7 回**(`backfill_race` 4 回・`backfill_class` 2 回・`backfill_payout` 1 回)= **7,400 行**。
- 初回だけ `collectSettled` が 6 文(`backfill_race` 3・`backfill_class` 2・`backfill_payout` 1)= 6,300 行。
- 本番の最初の夜(11/4 UTC 16:00 の 1 時間)の DO の読み取りは 15,952 行で、シミュレーションの約 1.4 万行(7,400 + 6,300 + `backfill_meta` の読み 71 回ほか)と近い。なお、シミュレーションの 3 表の行数(1,100・1,000・1,000)は**仮定**(本番の値は DO の中でしか読めない)。

**表の増え方**: 行が足されるのは、補完の段階で**取得を終えた(`*_done`)・失敗した・諦めた**レースだけ(`recordFillDone`・`recordClassDone`・`recordPayoutDone`・`recordFailure`)。新しいレースは結果もオッズも払戻もクラスも**取り込みの時点で揃う**ので、補完の対象にならず、行が増えない。したがって:

- 積み残しの消化中は、1 晩に最大 150 行(`BACKFILL_NIGHTLY_LIMIT`)ずつ増える。段階 4 は D1 の `race_backfill` で 540 レースが残っている(`st4 = 1`)ので、あと 4 晩(540 ÷ 150)で消化し、`backfill_payout` は約 1,140 行(#556 の時点で払戻が全馬 NULL だったレース数。`FILL_WIN_PAYOUT_SQL` の JSDoc)で止まる。
- 積み残しが無くなれば、増えるのは失敗の行だけ。
- 表は小さいまま(各 約 1,000〜1,600 行と仮定)なので、`excludedIds` は 1 晩 約 1 万行で頭打ち。DO の無料枠(500 万行/日)の 0.2%。直すなら `last_night` の索引を 3 表に足す(DO の書き込みが行の更新ごとに +1)が、**優先度は低い**。

## 5. 行が消えない表と、1 年後の見積もり

### 5.1 前提

**伸び方(分析件数/年)**: 直近 29 日(10/8〜11/5)は 297 件 → **A: 3,700 件/年**。全期間(7/14〜11/5 の 114 日)は 2,524 件 → **B: 8,100 件/年**。中央の全レース(年約 3,456 レース)と地方(年約 1.3 万レース)をすべて分析する **C: 26,000 件/年**(中央・地方のレース数は私の記憶による**仮定で、未検証**)(1 レースあたり 1.57 分析 = 2,524 ÷ 1,605 は今の実測)。
**1 分析あたりの子の行**: 馬 13.2、配分メタ 1、買い目 2、再計算 0.5 回 × 買い目 5。**1 レースあたり**: 結果 13.7 行、組合せ払戻 3.1・取込印 2.1、`horse_run_saves` 1、`horse_runs`(分析時)16。
**過去の結果の取得(#549)**: 5 年(2021-11〜)で約 1.73 万レース(= 3,456 × 5。上の仮定)。変換後の `horse_runs` は 1 レース 10.8 行(いまの実測。§2.1 の注)で、完了すると +16.2 万行(約 50 MB)。完了後は中央の年 3,456 レース × 10.8 行。
**1 行の大きさ(索引込みの概算)**: `analyses` 750、`analysis_horses` 190、`horse_runs` 235、`race_results` 100、`race_archive` 150、`daily_reports` 約 24 KB(15 行の `body_json` の平均 23,940 バイト)。ページの余りで × 1.3。標本は本番の `LIMIT 200` の平均(`analysis_horses` は 73〜159 バイト/行と古い順で違う)。

### 5.2 D1(行が消えない表)

| 表 | いま | A | B | C | B の容量 | 増え方・メモ |
|---|---:|---:|---:|---:|---:|---|
| `horse_runs` | 50,058 | 28.7 万 | 33.2 万 | 51.5 万 | 約 102 MB | **取得の完了で +16 万行**。以後は年に約 3.7 万 + 分析時 |
| `analysis_horses` | 33,348 | 8.2 万 | 14.0 万 | 37.7 万 | 約 35 MB | 分析 1 件 13.2 行 |
| `race_results` | 20,911 | 5.3 万 | 9.2 万 | 24.8 万 | 約 12 MB | 分析したレースだけ(取得の archive は入らない) |
| `analyses` | 2,524 | 6,224 | 10,624 | 28,524 | 約 10 MB | 7 本の索引つき |
| `race_combo_payouts` | 4,927 | 1.2 万 | 2.1 万 | 5.6 万 | 約 2 MB | |
| `analysis_close_bets` | 2,044 | 1.1 万 | 2.2 万 | 6.7 万 | 約 3 MB | |
| `analysis_allocation_meta` | 885 | 4,585 | 8,985 | 26,885 | 約 3 MB | 今の行は配分の導入後のぶん |
| `analysis_bets` | 1,756 | 9,156 | 17,956 | 53,756 | 約 2 MB | |
| `race_archive` | 2,264 | 2.1 万 | 2.1 万 | 2.1 万 | 約 4 MB | 5 年で約 1.73 万 + 年 3,456 |
| `daily_reports` | 15 | 145 | 145 | 145 | 約 4.5 MB | 開催日ごとに 1 件(約 24 KB)。年約 130 |
| `race_backfill`・`race_result_meta`・`race_conditions`・`horse_run_saves`・`race_combo_payout_imports`・`analysis_close` | 1,605・1,522・120・213・3,416・416 | | 6,764・6,681・5,279・5,372・14,250・4,466 | | 計 約 6 MB | |
| **合計(D1 全体)** | 33.4 MB(実測) | **約 140 MB** | **約 185 MB** | **約 370 MB** | | 500 MB に対し 28%・37%・74%。B は、上の表ごとの推定の合計(約 183 MB)に小さい表を足した値 |

- 無料枠の 1 DB 500 MB に対し、A・B は余裕がある。**C(全レース分析)では約 1.1 年で自前の 400 MB に届き**、取得と変換が止まる(`DB_SIZE_LIMIT_BYTES`)。
- 書き込みの上限(10 万行/日)に対し、変換の最大は 30,000 行/晩。年間の定常の書き込みは 1 日 数千行。
- 同じ式で今の大きさを見積もると 31.7 MB(実測 33.4 MB)で、5% 低い。

**1 年後の読み取り(B。一度に読む量)**

| SQL | いま | 1 年後(A / B / C) |
|---|---:|---|
| 検証の再計算 `readAll` | 7.1 万行 | 19 万 / 33 万 / 91 万 |
| 整合検査 | 3.0 万行 | 7.5 万 / 13 万 / 35 万 |
| `horse_runs` の診断(3 文) | 30 万行 | 173 万 / 199 万 / 309 万 |
| 変換 DO の目録の走査(8 周/晩) | 1.8 万行 | 16.6 万(A・B・C 共通) |
| `CLASS_DISTRIBUTION` | 5,025 行 | 1.2 万 / 2.1 万 / 5.7 万 |

### 5.3 DO(行が消えない表)

| DO | 表 | 増え方 | 今の行数 |
|---|---|---|---|
| `RaceArchiveFetchDO` | `ra_race`(1 レース 1 行。約 70 バイト)・`ra_day`・`ra_month` | 取得の完了までに約 1.73 万行、以後は年に約 3,456 行(約 0.2 MB)。**消えない** | 取得の開始(11/4 0:00 JST)から数日。本番の値は未取得(§7) |
| `ResultBackfill` | `backfill_race`・`backfill_class`・`backfill_payout` | §4.2。積み残しの消化で約 1,000〜1,600 行ずつ、以後は失敗のぶんだけ | 同上 |
| `RaceArchiveRunsDO` | `rr_fail`(変換に失敗中)・`rr_reject`(拒否の決着) | 失敗・拒否したレースだけ | 同上 |
| `RaceDay`(日ごと) | `race_day_tasks`・`race_day_morning_prior`(`result_json`)・`race_day_plan`・`race_day_result`・`race_day_notify` ほか | **開催日ごとに 1 インスタンスで、消えない**(`deleteAll` は呼ばない)。取得キャッシュ(`fetch_cache`)は保持期間で掃除する。LLM の応答は完了で消す。`race_day_morning_prior` は 1 レース 1 行で残る | 大きさは**測れなかった**: GraphQL の `durableObjectsStorageGroups` は空、`durableObjectsPeriodicGroups` に `storedBytes` が無い。DO 内で `ctx.storage.sql.databaseSize` を読めば測れる(コードを足す必要があるので今回は見送り) |

## 6. 直す候補(効き目の大きい順)

**1. 検証の再計算を、上限の引き下げと、開催日ごとの読みに分ける**
- 何を: `readAll`(9 本の全表読み 7.1 万行/回)。
- どう直すか: ①(設定)`VERIFY_DAILY_LIMIT` を 20 → 6 程度に。②(SQL + 設計)開催日ごとに読み、変わった開催日(透かしより新しい分析の開催日、結果の入った開催日)だけ読み直す。1 開催日の読み(分析・配分メタ・買い目・結果・組合せ払戻・取込印)は 24 分析の日で約 600 行(`検証(1日)` 5 文の合計 25 + 48 + 24 + 384 + 120 + 取込印)。核の `computeVerifyReport` に渡す形は変わらないので、DO の kv に開催日別の行を持たせて、再計算のたびに合わせる。
- 書き込みの増え方: D1 は 0。kv に開催日別の行(1 日 数 KB。1 年で約 120 日 × 数 KB)。
- 効き目: いま 1 回 7.1 万 → 約 3 千(3〜5 開催日が変わる場合)。1 年後 B は 33 万 → 約 5 千。

**2. 変換 DO の目録を、未変換だけ引く**
- 何を: `SELECT_CATALOG_PAGE_SQL` の毎時の全周(`race-archive-runs-core.ts` の `step` → `endOfPass` が、変換が 0 件の周のあと 1 時間待って、また先頭から周る)。
- どう直すか: 部分索引 `idx_race_archive_runs_pending ON race_archive (race_id) WHERE runs_version IS NULL` を足し、`WHERE runs_version IS NULL AND race_id > ? ORDER BY race_id LIMIT ?` で未変換だけを引く(`RESULT_RUN_VERSION` を上げて再変換するときだけは、全走査の旧い形に切り替える)。
- 書き込みの増え方: 索引の行がレース 1 件につき +2(入る +1・変換で消える +1)。取得の完了までに約 3.5 万行、以後は年に約 7 千行。
- 効き目: 完了後の 13.8 万行/晩 → ほぼ 0。

**3. 整合検査を、直近の開催日に絞る**
- 何を: `RECONCILE_RACE_BACKFILL_SQL`(夜に 1 回の全レース再計算)。
- どう直すか: `raceBackfillStateSelect(analysesWhere, resultsWhere)` に、`kaisai_date >= 14 日前` のレースだけを渡す(`WHERE a.race_id IN (SELECT race_id FROM analyses WHERE kaisai_date >= ?1 AND kaisai_date <= ?2)` と、結果側の同じ絞り)。全件の検査は月に 1 回。
- 書き込みの増え方: 0(ずれが無ければ)。
- 効き目: 3.0 万 → 約 2.3 千(96 レース)。1 年後 B は 13 万 → 約 2.3 千。**ただし本番で走っているかの確認が先**(§7)。

**4. 期間集計を、ID を先に取って引く**
- 何を: `READ_PERIOD_SQL` 6 本(日報の 28 日累計・月報)。6 文それぞれが、同じ `latest` の CTE(`ROW_NUMBER() OVER (PARTITION BY race_id ORDER BY analyzed_at DESC …)`)を作り直している。
- どう直すか: 1 文目(races)で分析 ID・レース ID を取り、残り 5 文は `IN (SELECT value FROM json_each(?))` で引く(`prior-export-store.ts` の書き方と同じ)。batch の 2 段階になる(サブリクエストが 1 増える)。
- 書き込みの増え方: 0。
- 効き目: 12,781 → 8,738 行(−32%)。本番の 1 回 3.3 万 → 約 2.3 万。1 日 1〜5 回で 1 日 1 万〜5 万行減る。

**5. `FILL_*` の 3 本を、馬番をキーにした JSON で引く**
- 何を: `FILL_WIN_ODDS_SQL`・`FILL_SCRATCHED_SQL`・`FILL_WIN_PAYOUT_SQL`。
- どう直すか: 束縛する JSON を `{"1":[3.5,1],"2":[…]}` の形にし、`UPDATE race_results SET win_odds = COALESCE(win_odds, json_extract(?1, '$."' || umaban || '"[0]')), … WHERE race_id = ?2 AND (…)` にする。`json_each` の結合が無くなる。代案は `WITH j AS MATERIALIZED (…) UPDATE … FROM j`(70 行)。
- 書き込みの増え方: 0(書き換わる行は同じ)。
- 効き目: 239 → 15 行/回(14 頭)。いまの 2.5 万行/日 → 約 2 千行/日。補完の消化が終われば 1 日 0.3〜0.8 万行 → 0.5 千行。

**さらに小さい候補(上位 5 件の次)**
- `horse_runs` の診断(`readHorseRunsStatus`)3 文: 1 回 30 万 → 1 年後 199 万行。書き込み時に件数を小さな集計表に持つか、診断を 1 文にまとめる。管理者が開くときだけなので、自動の更新が無いことを確かめる。
- `CLASS_DISTRIBUTION_SQL`: 5,025 行/回。`analyses (race_class, race_id)` の索引にすると 1 回あたり約半分。書き込みが分析 1 件あたり +1〜2 行。
- DO の `excludedIds`・status の走査(§4.2)。`last_night`・`state` の索引は DO の書き込みが増える。優先度は低い。
- `PENDING_SQL` の `COUNT(*) OVER ()`: 未確定の行を全部読む(補完中だけ)。`COUNT` を別の文にして `LIMIT` を効かせる。

## 7. 未確認と、次の Issue の候補

- **整合検査が本番で走ったか**: 11/5 の 01:00 JST の夜(#597 の公開の後の最初の窓)に、`RECONCILE_RACE_BACKFILL_SQL` に当たる SQL(`ON CONFLICT(race_id) DO UPDATE SET kaisai_date` で `json_each` が無い形)が、30 日分の D1 の SQL 別の集計に**無い**。同じ夜に補完の書き込み(`UPDATE race_results SET win_payout` 267 回)は記録されているので、DO は動いている。`reconcileTonight` は失敗を握る(`result-backfill: race_backfill reconcile failed` を warn に出すだけ)ので、ログ(`wrangler tail`・Cloudflare のログ)で `race_backfill reconciled` か `reconcile failed` を確認する。**確認できるまで、整合検査が動いているとは書かない**。
- **DO のストレージの大きさ**: GraphQL で取れなかった(§5.3)。日ごとの `RaceDay` の `race_day_morning_prior` が 1 年でどれだけになるかは、DO の中で `ctx.storage.sql.databaseSize` を記録する変更が要る。
- **`RaceArchiveFetchDO` の表の行数**: DO の SQLite を外から読めない。取得の status(`GET /api/race-archive`)は管理者の認証が要るので、今回は呼んでいない。
- **検証の再計算が 1 日に何回走るか**: D1 の集計からは、`readAll` 系の SQL が出た日(10/10・10/11・10/12・10/17・10/25)の読み取りしか分からない。現行の SQL と完全に一致する文だけを数えると、10/11 は約 30.8 万行(その日の 70%。馬の全件読みが 10 回)、10/17 は約 12.4 万行(33%。4 回)、10/25 は約 12.7 万行(9%。3 回)。30 日の合計は 646,434 行(4.5%)。
- 次の小さい Issue の候補(タイトル案): ① 検証の再計算の上限を下げる(設定のみ) ② 変換 DO の目録を未変換だけ引く(索引 1 本 + クエリ) ③ 整合検査を直近 14 日に絞る(+ 動いているかの確認) ④ 期間集計の ID 先取り ⑤ `FILL_*` の JSON を馬番のオブジェクトにする ⑥ 検証の再計算を開催日ごとに読む(設計) ⑦ `horse_runs` の診断を軽くする。①②⑤は小さく、先に切り出せる。

## 付録 再現の手順と、置いたファイル

`docs/investigations/db-usage-594/` に置いた。

| ファイル | 内容 |
|---|---|
| `fetch-d1-queries.py` | 本番の D1 の SQL ごとの回数・読み取り・書き込み(GraphQL。読み取りだけ)。`python3 fetch-d1-queries.py <アカウント ID> <database_id> <開始 UTC> <終了 UTC> <出力>`。期間は 4 週 4 日まで |
| `prod-d1-queries-30d.tsv` | 10/6〜11/5 の SQL の型ごとの回数・読み取り・書き込み(362 型。型は IN 句と VALUES を畳んだもの) |
| `record-sql.patch` | `cloud/test/local-bindings.ts` に当てると、環境変数 `SQL_LOG` のファイルに `prepare` の SQL を追記する(一時の変更。当てたまま commit しない) |
| `explain-sql-log.mjs` / `explain-plans.txt` | 記録した SQL への EXPLAIN。`node --no-warnings explain-sql-log.mjs <記録> > explain-plans.txt` |
| `do-explain.mjs` | DO の SQLite の主な SQL の EXPLAIN(DDL は `cloud/src` の `CREATE TABLE` から) |
| `measure.test.ts.txt` / `measure-result.json` | 本番と同じ規模の合成データでの `rows_read` の計測と、直し方の案の計測(`cloud/test/` にコピーして流す) |
| `sim-excluded-ids.test.ts.txt` / `sim-excluded-ids-result.json` | 結果の補完の `excludedIds` の 1 晩の回数のシミュレーション |

本番の行数は `SELECT COUNT(*) FROM <表>` を表ごとに 1 回(合計 127,451 行の読み取り)。標本の平均(1 行の大きさ)は `LIMIT 200〜300` の SELECT。`horse_runs` の内訳は `GROUP BY source, substr(race_key,1,4)` を 1 回(100,128 行)。分析の日別は `GROUP BY substr(analyzed_at,1,10)` を 1 回(5,048 行)。

数の根拠のコマンド: `git grep -n 'prepare(' cloud/src | wc -l` = 156、`git grep -l 'prepare(' cloud/src | wc -l` = 22、`ls cloud/migrations | wc -l` = 35、`git grep -l openLocalBindings cloud/test | wc -l` = 61(`local-bindings.ts` 自身を含む)、`grep -c '^## ' explain-plans.txt` = 167、`grep -c '注意:' explain-plans.txt` = 47。
