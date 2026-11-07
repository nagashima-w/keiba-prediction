-- クラウド版(D1)の migration 0040: 統計モデルの並走(影の計算)の記録(Issue #649 段階 2・3)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧 Worker はこれらの表を参照しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)と、cloud/test/d1-schema.integration.test.ts の期待も同時に直す。
-- ★デプロイの順序: これらを書く新しい Worker は、migration の適用より前に出てもよい(影の書き込みは分析の保存とは別の呼び出しで、失敗しても握って警告にする。分析の保存は成功のまま)。
--   適用前は影の行が書かれないだけで、適用後の分析から記録が始まる。
-- 読み書きは cloud/src/analysis-shadow-repository.ts だけ(書き込みは D1AnalysisStore.saveAnalysis が、分析の保存の直後に呼ぶ)。
--
-- 買い目・配分・EV・画面・LLM のどれにも使わない。結果が出たあとに、いまのやり方(analysis_horses の prior・adjusted_prob と、そこから換算した勝率・2着内率)と並べて当たり具合を比べるための記録。
--
-- analysis_shadow_horses: 分析 × 馬で 1 行(モデルによらない部分)。
--   analysis_id         analyses.id
--   umaban              馬番
--   input_win_odds      計算に使った分析の時点の単勝オッズ(倍)。取れていない馬は NULL
--   market_q            市場の確率 = (1/単勝オッズ)をレース内で合計 1 に割り戻した値。1 頭でもオッズが無いレースは全馬 NULL
--   flag_long_rest      休み明け(前走から 181 日以上)。1/0。前走が分からない馬は NULL(以下の印も同じ)
--   flag_surface_change 芝とダートの替わり(前走のコース種別が今回と違う)
--   flag_front_runner   前走で逃げた(最初のコーナーの通過順 ÷ 前走の頭数 ≤ 0.125)
--   flag_longshot_slump 人気薄(q < 0.05)で直近 3 走の平均着順が 11.5 以上
--   印の定義は #653 の探索(docs/investigations/market-blindspots-653-fable/report.md)に合わせる。packages/core/src/ev/stat-shadow-flags.ts。
-- analysis_shadow_probs: 分析 × 馬 × モデルで 1 行。
--   model               モデルの版の名前(packages/core/src/ev/stat-shadow-coef.ts の SHADOW_MODEL_ODDS・SHADOW_MODEL_NODDS。係数を学び直したら新しい名前にする)
--   win_prob / top2_prob / top3_prob  勝率(レース内の合計 1)・2着内率(合計 2)・3着内率(合計 3)
-- どちらも WITHOUT ROWID(主キーが行の実体。副索引は作らない = 書き込みの行を増やさない)。
-- 書き込みの見積もり: 1 分析で、頭数 N に対して N 行(馬)+ 2N 行(確率。オッズなしの版だけのレースは N 行)= 最大 3N 行。中央 16 頭で最大 48 行。
--   本番の分析の実測(2026-07-19〜11-03 の 61 開催日、prior の書き出しから): 1 日あたり中央値 16 レース・209 頭、最大 36 レース・495 頭(2026-08-09)。
--   最大の日で 495 × 3 = 1,485 行(D1 の書き込み 1 日 10 万行の約 1.5%)。中央値の日で 627 行。地方・予想オッズの分析は書かない。再実行で分析が増えた分は、同じ割合で増える。
--   1 行は約 60 バイトで、最大の日で約 90KB。1 年(開催 100 日前後)で数十 MB の見込み(読み出しは結果の比較の別 Issue で、ここでは増やさない)。

CREATE TABLE analysis_shadow_horses (
  analysis_id INTEGER NOT NULL,
  umaban INTEGER NOT NULL,
  input_win_odds REAL,
  market_q REAL,
  flag_long_rest INTEGER,
  flag_surface_change INTEGER,
  flag_front_runner INTEGER,
  flag_longshot_slump INTEGER,
  PRIMARY KEY (analysis_id, umaban)
) WITHOUT ROWID;

CREATE TABLE analysis_shadow_probs (
  analysis_id INTEGER NOT NULL,
  umaban INTEGER NOT NULL,
  model TEXT NOT NULL,
  win_prob REAL NOT NULL,
  top2_prob REAL NOT NULL,
  top3_prob REAL NOT NULL,
  PRIMARY KEY (analysis_id, umaban, model)
) WITHOUT ROWID;
