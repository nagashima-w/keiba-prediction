-- クラウド版(D1)の migration 0046: 中央のレースの、発走の 10 分前と 5 分前の単勝・複勝の全頭のオッズを貯める表 odds_snapshots を足す(Issue #732。探索〈#700〉と、フォワードテスト〈#741〉の材料)。exe の SQLite には無い、D1 専用の表。
-- 5 分前が必須で、10 分前は比べるための記録(ユーザー決定 2026-11-13)。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧 Worker はこの表を参照しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表を書く新しい Worker は、migration の適用より前に出してはならない。deploy-cloud.yml は migration を wrangler deploy より前に適用する(表が無い間は保存が失敗するだけで、分析は止まらない)。
-- 書くのは cloud/src/odds-snapshot-repository.ts だけ(取得の段取りは race-day-odds-snapshot-stage.ts。RaceDay の DO が、計画の中央の行ごとに発走の 10 分前・5 分前の予定を積んで取る)。
-- ★追記だけ: 記録した行は書き換えない。書くのは INSERT 1 文だけ(同じ (race_id, lead_min) が既にあれば何もしない)。UPDATE・DELETE は書かない。
--
-- odds_snapshots: レース・時点で 1 行(JRA の公式サイトの単勝・複勝の頁から。netkeiba は使わない)。
--   race_id            race_id(12 桁)。主キーの前半
--   lead_min           時点。発走の何分前の予定か(10 または 5)。主キーの後半
--   kaisai_date        開催日(YYYYMMDD)
--   start_ms           発走の時刻(UTC のエポックミリ秒。netkeiba の一覧の発走時刻から)
--   due_ms             取る予定の時刻(= start_ms − lead_min 分)
--   taken_at_ms        実際に取った時刻(UTC のエポックミリ秒。予定の時刻 due_ms ではない。頁を取って取得キャッシュに置いた時刻)。status が ok 以外の行は、取れなかった・取らないと決めた時刻(最後の試行)。実際の発走までの残りは start_ms − taken_at_ms
--   official_datetime  JRA の頁にある「N時M分現在オッズ」の時刻(JST の `YYYY-MM-DD HH:MM:00`)。頁に無ければ NULL
--   odds_status        頁の発売状態(middle = 発売中の暫定 / result = 確定 / yoso = 予想)。ok のときだけ入る
--   status             ok(取れた)/ failed(取れなかった)/ skipped(取らなかった)
--   reason             failed・skipped の理由(固定の語: fetch-failed・too-late。10 分前の取得が遅れて 5 分前の時刻にぶつかるときは、10 分前が too-late になる)。ok のときは NULL
--   attempts           取得を試みた回数
--   horses_json        馬ごとの [馬番, 単勝, 単勝の人気, 複勝の下限, 複勝の上限, 馬の ID] の配列(JSON。馬番の昇順)。オッズが読めない・無い値は null(取消・発売前など)。ok のときだけ入る
--                      馬の ID は、JRA の頁の馬のリンク(CNAME=pw01dud00 + 10 桁)から読んだ 10 桁の文字列。リンクが読めない馬は null。netkeiba の馬の ID と同じかは、#637 で 18 頭を確かめただけ(探索は馬番でも出馬表と突き合わせられる)
-- WITHOUT ROWID・副索引なし(1 行の書き込みが 1 行。1 日の中央は 36 レース前後 × 2 時点で、1 行は約 1KB)。
--   探索の読み方の例: SELECT race_id, lead_min, taken_at_ms, start_ms, official_datetime, horses_json FROM odds_snapshots WHERE kaisai_date = '20261115' AND status = 'ok' ORDER BY race_id, lead_min;
--   (kaisai_date に索引は無い。主キーの全走査になるので、探索の側で全件を読んで手元で絞る使い方を想定している。1 年でも 2 万行に満たない見込み)
CREATE TABLE odds_snapshots (
  race_id TEXT NOT NULL,
  lead_min INTEGER NOT NULL,
  kaisai_date TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  due_ms INTEGER NOT NULL,
  taken_at_ms INTEGER NOT NULL,
  official_datetime TEXT,
  odds_status TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL,
  horses_json TEXT,
  PRIMARY KEY (race_id, lead_min)
) WITHOUT ROWID;
