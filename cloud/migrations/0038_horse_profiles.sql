-- クラウド版(D1)の migration 0038: 馬の血統・生産者・馬主と、レースごとの出走時の情報(ブリンカー・減量・マルガイ)を貯める表を足す(Issue #639。親は #542・#636)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。表が無い間は新しい Worker の保存が止まるだけで、分析は止まらない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★番号 0038 は #630 で一度作って取り消したもの。取り消しは承認印付きの公開より前で、本番の D1 には一度も当たっていない。
--
-- この Issue では**保存するだけ**(分析・プロンプト・画面には使わない。効くかは #542・#636 で測ってから)。
-- 表の名前は出どころに依らない(#640 で netkeiba の馬のページから取る過去の馬の分も、同じ表に入る)。出どころは `source` 列(`jra` など)で持つ。
-- 書くのは cloud/src/jra-entries-repository.ts だけ。1 回の書き込みは、json_each で束縛した配列を表ごとに 1 文(行数によらず文の数は一定)。
-- 値が変わらないときは書かない(ON CONFLICT DO UPDATE ... WHERE が偽なら行を書かない)ので、同じ馬を毎回取っても書き込みの行数は増えない。
--
-- horse_profiles: 馬ごとに 1 行。生まれが変わらない項目(血統・生産者)は上書きする。
--   horse_id       馬の ID(10 桁。netkeiba の馬の ID と JRA の馬の番号は同じ。#637 で 18 頭が全部一致)。主キー
--   name           馬名(読み取った時点のもの)
--   sire           父
--   dam            母
--   dam_sire       母の父
--   breeder        生産者
--   source         この行の値を最後に書いた出どころ(`jra` など)
--   first_seen_on  最初に取った開催日(YYYYMMDD)。上書きしない
--   updated_on     値が最後に変わった開催日(YYYYMMDD)。同じ値を取り直しても変えない
-- 値が NULL の列は「その回は読めなかった」。既に入っている値を、読めなかった回で消さない(COALESCE)。
CREATE TABLE horse_profiles (
  horse_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  sire TEXT,
  dam TEXT,
  dam_sire TEXT,
  breeder TEXT,
  source TEXT NOT NULL,
  first_seen_on TEXT NOT NULL,
  updated_on TEXT NOT NULL
) WITHOUT ROWID;

-- horse_owner_history: 馬主は変わることがあるので、(馬, 馬主)ごとに 1 行。いつからいつまで見えたかを持つ。
--   first_seen_on / last_seen_on  その馬主を見た最初と最後の開催日(YYYYMMDD)
-- 馬主は文字列のまま(制御文字を除き、64 字に切る)。法人名の表記ゆれは正規化しない。
CREATE TABLE horse_owner_history (
  horse_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  source TEXT NOT NULL,
  first_seen_on TEXT NOT NULL,
  last_seen_on TEXT NOT NULL,
  PRIMARY KEY (horse_id, owner)
) WITHOUT ROWID;

-- race_horse_entries: レースと馬の組ごとに 1 行の、出走時の情報。「ブリンカー無し」の行も入れる(入れないと、取れていないのと区別できない)。
--   race_id        netkeiba の race_id(12 桁)
--   umaban         馬番。まだ決まっていなければ NULL(重賞以外は、枠順が決まるまで空)
--   blinker        ブリンカー着用(1)か(0)。JRA の印に「初めて着ける」の区別は無い(#636)
--   reduction_kg   今回の騎手の減量(kg)。無ければ 0
--   foreign_mark   馬名の前のマルガイ(外国産馬)の印(1)か(0)
--   updated_on     行を作った、または値が最後に変わった開催日(YYYYMMDD)
CREATE TABLE race_horse_entries (
  race_id TEXT NOT NULL,
  horse_id TEXT NOT NULL,
  source TEXT NOT NULL,
  umaban INTEGER,
  blinker INTEGER NOT NULL,
  reduction_kg REAL NOT NULL,
  foreign_mark INTEGER NOT NULL,
  updated_on TEXT NOT NULL,
  PRIMARY KEY (race_id, horse_id)
) WITHOUT ROWID;

-- jra_entry_fetches: JRA の出馬表の取得の試みの記録。1 開催日 × 場 × 試行番号で 1 行。
--   venue_code    JRA の場コード(01〜10)。'00' は開催の選択・レースの選択をたどる回(場ごとの CNAME を集める)
--   attempt       その場の何回目の試みか(1 から)。主キーの衝突 = その試みは既に行った(JRA に出る前に INSERT する)
--   attempted_at  試みた時刻(エポックミリ秒)
--   finished_at   結果を記録した時刻(エポックミリ秒)。NULL = 試みたが結果を記録できなかった
--   result        結果の分類(固定の語: ok・partial・no-venues・timeout・network・redirect・too-large・http-<status>・param-error・shape-mismatch・race-mismatch・other)
--   races_total   取りに行ったレースの数 / races_saved 保存したレースの数
--   horses_skipped  馬の ID が 10 桁でないなどで保存しなかった馬の数
--   requests      JRA に送った本数
--   elapsed_ms    取得から保存までの所要時間(ミリ秒)
--   complete      その場の全レースが保存できた(1)か(0)。1 の回があれば、その場は取り直さない
CREATE TABLE jra_entry_fetches (
  kaisai_date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  races_total INTEGER,
  races_saved INTEGER,
  horses_skipped INTEGER,
  requests INTEGER,
  elapsed_ms INTEGER,
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kaisai_date, venue_code, attempt)
) WITHOUT ROWID;
