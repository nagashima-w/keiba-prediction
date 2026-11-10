# D1・DO の SQLite に SQL を足すときの決まり

D1 と Durable Object(DO)の SQLite に新しい SQL を足すとき、全走査や、表と一緒に増え続ける読み取りを入れないための決まりである(Issue #632。親は #594)。
#593・#597・#600・#613〜#616 の直しで分かった注意を、次に SQL を書くときに使える形で残した。数字と経緯の根拠は [`docs/investigations/db-usage-594.md`](./investigations/db-usage-594.md) にある(とくに §0・§3.2・§6・§7)。

## 決まり

1. **起床・要求・cron のたびに、表の全部を読む SQL を足さない。**
   読む行数が表の大きさに比例するなら、索引を使うか、変わった分だけ読む形にする。
   無料枠の D1 の読み取りは 1 日 500 万行である。表が増えるほど、全走査はその枠を食う(検証の再計算がその例で、#616 で置き換え中)。
2. 索引を足すときは、書き込みの行数の増え方も見積もる。
   1 行の書き込みにつき、索引の行がいくつ増えるかを数える。D1 と DO の SQLite の書き込みは、無料枠で 1 日 10 万行までである。
3. migration は追加だけにする。
   `UPDATE`・`DELETE` などを書かない(#171。`scripts/test/cloud-config-guard.test.ts` が固定している)。データを直すときは、コードの経路で行う(#630)。
4. 1 回の呼び出しで使える D1 の文は 50 まで(Free)。
   `batch` の中の文も 1 つずつ数える。
5. 値の並びは `json_each` で束縛する。
   `IN (SELECT value FROM json_each(?))` で引く。SQL の文字列に値を埋め込むのは、整数か、形を確かめた ID だけにする(`targets-repository.ts` の `idList` が例)。
6. SQL 別の集計(`d1QueriesAdaptiveGroups`)には出ない SQL がある。
   集計に出ないことを「走っていない」の根拠にしない。整合検査は、ログでは動いているのに集計に出ない(db-usage-594.md §7)。
7. **新しい SQL を足したら、実行計画の検査も足す。** 次の節のとおり。

## 実行計画の検査

`cloud/test/sql-plan-inventory.test.ts` が、`cloud/src` の各モジュールが export する SQL(文字列定数。オブジェクトの値の中も含む)を自動で集める。
集めた SQL が、次の 4 区分のどれかに載っていなければ赤になる。載せる場所は `cloud/test/sql-plan-registry.ts` である。

| 区分 | 意味 | 検査 |
|---|---|---|
| ここで検査する(`HERE`) | 全走査が無い。 | `node:sqlite` に `cloud/migrations` を順に当てた DB で `EXPLAIN QUERY PLAN` を見る。実在の表への `SCAN` があれば赤。一時の並べ替え(`USE TEMP B-TREE`)は、範囲が絞られている理由つきで載せたものだけ許す。 |
| 既存の検査(`EXISTING`) | workerd を開く integration テストが計画を見ている。 | 複製しない。そのファイルが実在し、SQL の名前と `EXPLAIN QUERY PLAN` を含むことだけ確かめる。 |
| 既知の例外(`EXCEPTIONS`) | 今も全走査がある。 | 理由と Issue を付ける。新しい全走査は赤。例外の SQL が直って全走査でなくなったときも赤になり、一覧から外すよう促す。 |
| 検査対象外(`EXCLUDED`) | 検査しない。 | 理由を付ける。 |

export されない SQL を組み立てる関数のうち、export されたもの(`targetsSql`・`verifyDayHorsesSql` など)は、サンプルの引数で SQL にして同じ一覧に載せる。
export されたのに載せていない `…Sql` 関数があれば赤になる。

DO の SQLite は、SQL を文字列定数で持たず、コアのメソッドの中で組み立てる。そのため DO のコアのテスト 3 本が、流れた全部の文を `EXPLAIN` にかける。
全走査か一時の並べ替えがある文は、テストの中の例外の一覧に載っていなければ赤になり、一覧の項目に当てはまる文が無くなっても赤になる。

### 新しい全走査が見つかったとき

- 例外に載せて赤を消さない。まず、表が増えたとき読む行数がどう増えるかを数え、索引か書き換えで直せるかを調べる。
- 直せるなら別の Issue を切る。直さないと決めたときだけ、理由と Issue 番号を付けて例外に載せる。
- 一時の並べ替えを許すのは、`WHERE` が日付・ID の索引で絞られていて、並べ替える行が小さいときだけである。理由にそれを書く。

### 限界

- Node 組込みの SQLite は、本番の D1 と同じビルドとは限らない。計画の細部はずれうる。大筋(索引を使うか全走査か)は同じなので、デプロイ後は D1 の分析(読み取り行数)でも確かめる。
- 計画が全走査でなくても、読む行数が表の大きさに比例することはある(`SEARCH` の範囲が広い場合など)。この検査は全走査と一時の並べ替えを捕まえるだけで、行数は見ない。行数は `meta.rows_read` を見る integration テストで確かめる(`verify-pending-index.integration.test.ts` など)。
- 自動の収集が拾わない SQL は、手で検査を足す。種類と主な例は次のとおり。この種類の SQL を足すときは、検査を手でテストか上の一覧に足す。
  - export されない定数と、`prepare("…")` への直書き。例: `allocation-export-store.ts` の `HORSES_SQL`・`BETS_SQL`、`analysis-repository.ts` の `SELECT_ONE_SQL`、`baba-repository.ts`・`jockey-results-repository.ts`・`trainer-results-repository.ts`、`result-repository.ts` の直書き、`horse_runs` の status。
  - 配列や、2 段より深い入れ子のオブジェクトで export された SQL(収集は文字列定数と、1 段のオブジェクトの値だけを拾う)。
  - 名前が `…Sql` でない、export された組み立て関数(漏れ止めは名前が `…Sql` の関数だけを見る)。
  - `*-do.ts`・`worker.ts`(取り込まない。今は SQL の定数が無い。足したら、収集の対象にできるか確かめる)。

## 検査の一覧

数は `cloud/test/sql-plan-registry.ts` の鍵の数である(2026-11-06 時点、#639・#642 の分を含む。`collectExportedSql()` が 85 件、組み立て関数が 16 件で、合計 101 件)。

| 区分 | 件数 |
|---|---:|
| ここで検査する | 65(うち、一時の並べ替えを理由つきで許すもの 6) |
| 既存の検査 | 21 |
| 既知の例外 | 15 |
| 検査対象外 | 0 |

### D1 の SQL

ここで検査する(一時の並べ替えを許すもの。理由は `sql-plan-registry.ts`): `LIST_DAY_ANALYSES_SQL`・`READ_PERIOD_SQL.races`・`LAST_DAY_STATUS_SQL`・`TARGETS_ANALYSES_SQL`(どれも 1 日か期間の分析を開催日の索引で絞ったあとの `ROW_NUMBER() OVER`・`ORDER BY`)と、`MARK_VERIFY_RACES_SQL`・`MARK_VERIFY_BY_ANALYSIS_IDS_SQL`(束縛した配列の数だけ)。

ここで検査する(全走査も一時の並べ替えも無いもの): 上のほか、再計算の保存・読み(`analysis-close.ts`)、`NEEDING_REPORT_SQL`、`READ_RESULTS_SQL`、`READ_PERIOD_SQL` の残り 5 本、`RECORD_SQL`、`INSERT_MONTHLY_SQL`・`REPLACE_MONTHLY_SQL`、`RECOMPUTE_RACES_SQL`・`RECOMPUTE_BY_ANALYSIS_IDS_SQL`、`settleRaceBackfillSql`、`SAVE_RACE_CLASS_SQL`、設定の読み書き、`VERIFY_DAY_ANALYSES_SQL`・`VERIFY_NO_DATE_ANALYSES_SQL`、騎手名・調教師名の書き込み、JRA の出馬表の保存と取得の記録(`jra-entries-repository.ts` の 6 本。#639)、馬の頁の属性の保存と取る馬の読み出し(`jra-horse-repository.ts` の 3 本。#697。`horse_runs` の主キーの範囲読みと、json_each から `horse_profiles` の主キーの引きと、`horse_runs` に中央の走があるかの EXISTS〈主キー先頭の引き。Issue #725〉)、過去のブリンカーの保存と取り終えたレースの確認(`past-blinker-repository.ts` の 3 本。#698。json_each から `past_blinker_races` の主キーの引きと、json_each からの INSERT 2 本)、`targetsSql`・`targetsCloseSql`・`verifyDayHorsesSql`・`verifyDayAllocationSql`・`verifyDayResultSql`・`verifyDayCloseSql` の各文。

#### 既存の検査(integration テスト)

- `FIT_*_SQL` 3 本: `monthly-report-repository.integration.test.ts`
- `LOAD_SQL`: `kaisai-days-repository.integration.test.ts`
- `PENDING_SQL`: `verify-pending-index.integration.test.ts`
- `SELECT_CATALOG_PAGE_SQL`・`SELECT_CATALOG_PENDING_PAGE_SQL`: `race-archive-runs-index.integration.test.ts`
- `LIST_UNIMPORTED_SQL`・`LIST_UNIMPORTED_BY_DAY_SQL`: `result-repository.integration.test.ts`
- `LIST_*_BACKFILL_SQL`・`COUNT_*_BACKFILL_SQL` 8 本と `RECONCILE_RECENT_RACE_BACKFILL_SQL`: `result-backfill-state.integration.test.ts`
- `FILL_WIN_ODDS_SQL`・`FILL_SCRATCHED_SQL`・`FILL_WIN_PAYOUT_SQL`: `result-fill-sql-equivalence.integration.test.ts`

#### 既知の例外(今も全走査がある)

| SQL | 呼ばれ方 | 理由 | Issue |
|---|---|---|---|
| `VERIFY_READ_SQL` 7 本・`VERIFY_CLOSE_READ_SQL` 2 本 | 検証の再計算(`readAll`) | 全件読み。開催日ごとの差分の再計算へ置き換え中 | #616 |
| `D1_HEALTH_SQL` | `/api/health` | 各表を `LIMIT 1` で読んで止まる。計画は `SCAN` と出るが、読む行数は表の大きさに依らない少数 | #612 |
| `CANDIDATES_SQL` | 統計モデルの書き出し(管理者の要求) | 分析の全件を読む。書き出した日だけ | #612 |
| `LOOKUPS_SQL`・`TRAINER_LOOKUPS_SQL` | 同上 | 騎手名・調教師名の表の全件。小さい表 | #612 |
| `RECONCILE_RACE_BACKFILL_SQL` | 結果の補完の整合検査(夜に 1 回) | 分析と結果の全件の突き合わせ。直近だけの `RECONCILE_RECENT_RACE_BACKFILL_SQL` もある | #612 |
| `CLASS_DISTRIBUTION_SQL` | 補完の status を開くたび(管理者) | 分析の全件を `race_class` で集計する | #612 |

#### 未検査(export されない SQL)

- `horse-runs-repository.ts` の `readHorseRunsStatus`(`horse_runs` の `GROUP BY` 3 文。管理者の `/api/horse-runs` だけ。画面は自動で呼ばない)は、`horse_runs` を全件読む。診断用である(db-usage-594.md §3.2)。
- `horse-runs-repository.ts` の `READ_SQL_HEAD`(`horse_id IN (…)`)、`analysis-repository.ts` の `listStatements`・`readStored` の `IN` 句など、実行時に組み立てる SQL は、`analysis-repository.integration.test.ts`・`analysis-list-order.integration.test.ts` などが計画を見ている。この一覧の自動の漏れ止めには載らない。

### DO の SQLite

| DO | 検査 | 全走査・一時の並べ替えの例外 |
|---|---|---|
| 騎手・調教師の指標(`market-edge-core.ts`。#642) | `market-edge-core.test.ts`。起床の経路の文に全走査が無いことを `EXPLAIN` で確かめる | なし(status の `COUNT(*)` だけ全走査で、起床の経路の外) |
| 変換(`race-archive-runs-core.ts`) | `race-archive-runs-core.test.ts`。起床の経路の文はすべて主キーの `SEARCH`(対照つき) | なし(status の文だけ全走査で、起床の経路の外) |
| 取得(`race-archive-fetch-core.ts`) | `race-archive-fetch-core.test.ts` | `ra_month` の選択(月ごとに 1 行の表)・`ra_month` の status の数え上げ・`skipped` の `GROUP BY`(status の画面だけ) |
| 補完(`result-backfill-core.ts`) | `result-backfill-core.test.ts` | `excludedIds`(`last_night` に索引が無い)・`collectSettled`(`state` に索引が無い)・status の数え上げ(db-usage-594.md §4.2。索引は別の Issue) |
| 日ごとの `RaceDay`(`race-day-do`) | 対象外 | 1 日ぶん(レース × 2 モード)の小さい表 |

kv だけを使う DO(`NetkeibaGate`・`VerifyReportDO` など)は SQL を持たない。
