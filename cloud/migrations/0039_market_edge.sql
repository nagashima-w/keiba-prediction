-- クラウド版(D1)の migration 0039: 騎手・調教師の「市場の予測との差」の指標(Issue #642。親は #548)。exe の SQLite には無い、D1 専用の表と列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧 Worker はこれらの表・列を参照しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES・race_archive の列と索引)も同時に直す。
-- ★デプロイの順序: これらを読み書きする新しい Worker は、migration の適用より前に出してはならない。deploy-cloud.yml は migration を wrangler deploy より前に適用する。
--   適用前に新しい Worker が目録を保存すると、UPSERT が market_version を参照して失敗する(取得 DO は保存の例外を握って数える)。
-- 読み書きは cloud/src/market-edge-repository.ts だけ(毎晩の段取りは market-edge-core.ts の DO `RaceMarketEdgeDO`)。
--
-- race_market_rows: レースで 1 行(中央の過去の結果から 1 回だけ作る)。毎晩の集計はこの表を開催日の範囲で読む(R2 を読み直さない)。
--   race_id      race_id(12 桁)。主キー
--   race_date    開催日(YYYY-MM-DD)。集計の窓(計算する日から 2 年)の絞り込みと、古い行の削除に使う
--   horses_json  計算に入った馬ごとの [騎手 ID, 騎手名, 調教師 ID, 調教師名, q, y] の配列(JSON)。頭数は配列の長さ
-- WITHOUT ROWID + race_date の副索引 1 つ。1 行の書き込みは 2 行(本体 + 索引)。1 行は約 1KB、2 年分(約 7,700 行)で約 8MB の見込み。
--
-- market_edge: 騎手・調教師ごとに 1 行(毎晩、集計の結果で置き換える)。
--   person_kind  jockey か trainer
--   person_id    騎手 ID・調教師 ID
--   name         窓の中で最後に出たレースの名前(結果ページの略称)
--   n            件数(計算に入った馬の数)
--   edge         指標 = 読み残しの合計 ÷ (件数 + 30)
--   hit_rate     3 着内率
--   pred_mean    市場の予測(p)の平均
--   computed_on  計算した日(JST の YYYY-MM-DD)
-- market_edge_meta: 直近の計算の記録を 1 行(id = 1 に固定)。画面が期間と係数を見せる・不収束の晩に前日の係数を使うために読む。
--   computed_on / window_from / window_to  計算した日と、集計した期間(開催日。両端を含む)
--   coef_json    [切片, logit(q), log(頭数)]。不収束の晩は前日の係数のまま(converged = 0)
--   converged    その晩の当てはめが収束したか(1/0)。0 のとき coef_json は前日の係数
--   fit_iterations / races / horses  反復の回数と、集計に入れたレース数・馬の数
ALTER TABLE race_archive ADD COLUMN market_version INTEGER;
-- race_archive.market_version: 市場の行への取り込みの済み印。NULL = 未処理、1 = 取り込み済み(版 MARKET_ROWS_VERSION)、-1 = 窓より古いので読まずに印だけ付けた。
--   目録の行の中身が変わる保存(saveRaceArchive の UPSERT が更新する場合)は NULL に戻す(runs_version と同じ作り)。
CREATE INDEX IF NOT EXISTS idx_race_archive_market_pending ON race_archive (race_id) WHERE market_version IS NULL AND kind = 'central';
-- ★索引の WHERE は、cloud/src/market-edge-repository.ts の SELECT_MARKET_PENDING_PAGE_SQL の WHERE と同じ形でなければならない(違うと SQLite は部分索引を使わず、目録の全行を読む)。
--   書き込みの増分: レースを目録に入れる(新規・中身が変わる再保存)たび +1 行(未処理で入るため。ローカルの workerd の実測で、保存の目録の書き込みが 2 → 3 行)。取り込んだとき索引から外れる分は rows_written に出なかった(課金上は +1 行かもしれないので、上限の見積もりでは数える)。

CREATE TABLE race_market_rows (
  race_id TEXT NOT NULL PRIMARY KEY,
  race_date TEXT NOT NULL,
  horses_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_race_market_rows_date ON race_market_rows (race_date);

CREATE TABLE market_edge (
  person_kind TEXT NOT NULL CHECK (person_kind IN ('jockey', 'trainer')),
  person_id TEXT NOT NULL,
  name TEXT,
  n INTEGER NOT NULL,
  edge REAL NOT NULL,
  hit_rate REAL NOT NULL,
  pred_mean REAL NOT NULL,
  computed_on TEXT NOT NULL,
  PRIMARY KEY (person_kind, person_id)
) WITHOUT ROWID;

CREATE TABLE market_edge_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  computed_on TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  coef_json TEXT NOT NULL,
  converged INTEGER NOT NULL,
  fit_iterations INTEGER NOT NULL,
  races INTEGER NOT NULL,
  horses INTEGER NOT NULL
);
