-- クラウド版(D1)の migration 0014: 各馬の戦績(1 走 1 行)の蓄積(Issue #256 段階A)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。表が無い間は新しい Worker の保存が失敗するが、分析は止まらない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- 番号が 0014 なのは、0011(#259)・0012(#226)・0013(#72)がこの Issue より先に公開されたため。
--
-- 目的: 事前分析(morning)の計算ステップで、キャッシュ済みの各馬の戦績(netkeiba の全戦績 API の1走ずつ)を、(馬 ID, 行の鍵)で冪等に貯める。
-- 段階A は「貯めるだけ」(取得は今のまま増やさない)。読み出し・画面・集計は無い。2〜4 週後の実測(horse_run_saves と診断 GET /api/horse-runs)で、
-- 取得を減らす段階 D(結果ページから行を作る)と騎手 × コースの集計(段階 E)・走破タイムの基準(#274)に進むかを決める。
-- 読み書きは cloud/src/horse-runs-repository.ts だけ。先読みのリーク: 保存は事実の記録なので絞らない。集計の側で「基準日より前」に絞る。
--
-- horse_runs: 1 走 1 行。WITHOUT ROWID(主キーが行の実体。副索引は作らない=書き込み行を増やさない。段階 C の「馬の戦績を全部読む」は主キーの先頭 horse_id で足りる)。
--   horse_id        馬 ID(netkeiba の 10 桁の数字)
--   race_key        行の鍵。レース ID(`raceIdRaw`。中央も地方も 12 桁)、無ければ(海外・リンク欠損)'X' + 日付(YYYYMMDD)。馬は 1 日に 1 走しかできないので衝突しない
--   parser_version  タプルの版数(packages/core の HORSE_RUN_PARSER_VERSION)。パーサの出力の意味を変えたら上げ、古い行は次の取得で上書きする(遅延した取り直し)
--   first_seen_at   初めて保存した時刻(エポックミリ秒)。上書きしても変えない。出来事の時刻ではない(時点の復元には行の日付を使う)
--   data            1 走の全項目(raceId を除く 26 スロットの JSON 配列。packages/core/src/scraper/horse-run-record.ts)。日付は `YYYY/MM/DD` の文字列(辞書順 = 日付順)
-- 容量の見積もり(仮定を含む): 1 行 約 300〜350 バイト(タプルは戦績フィクスチャ 72 行の平均 231 バイト前後。packages/core/test/scraper/horse-run-record.test.ts が範囲を固定)。
-- 本番の実際の大きさは、診断 GET /api/horse-runs の行数と D1 のダッシュボードの大きさで確かめる。
CREATE TABLE horse_runs (
  horse_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (horse_id, race_key)
) WITHOUT ROWID;

-- horse_run_saves: 1 回の保存(1 レースの事前分析の計算ステップ)につき 1 行の記録。段階 D・E に進むかの判断材料(重複・一致・不一致・新規の内訳)。
--   saved_at    保存した時刻(エポックミリ秒)。主キーの先頭にして、期間での範囲読みができるようにする
--   race_id     分析したレース ID
--   stats_json  集計(件数の JSON。形は cloud/src/horse-runs.ts の SaveStats)
CREATE TABLE horse_run_saves (
  saved_at INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  PRIMARY KEY (saved_at, race_id)
) WITHOUT ROWID;
