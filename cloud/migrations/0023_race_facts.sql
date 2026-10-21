-- クラウド版(D1)の migration 0023: レースの事実(芝ダ・距離・馬場・グレード・レース名)の写し(Issue #389〈#385-B の a〉)。exe の SQLite には無い、D1 専用の列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS)も同時に直す。
-- ★デプロイの順序: この列を SELECT する新しい Worker は、migration の適用より前に出してはならない(検証の読みと /api/health の疎通確認が落ちる)。
--   deploy-cloud.yml は migration を wrangler deploy より前に適用する。旧い Worker はこの列を参照しないので、適用後も壊れない(共存)。
--
-- 目的: 検証画面の「条件ごとの的中率と回収率」に、距離帯・馬場状態・クラス・芝ダを足す(#389-b。この migration は列と補完だけで、画面は変えない)。
-- これらはスナップショット(`race.courseType`・`distance`・`trackCondition`・`grade`・`raceName`)にだけあり、スナップショットは R2 の詳細にしか無い。検証の集計のたびに
-- R2 を読めない(Class B の費用)ので、`start_time`(0009)と同じく D1 に写す。写すのは検証の DO で、**発走時刻の補完の get に相乗りする**(追加の R2 読みは 0)。
-- 既存の分析は、同じ補完が一度だけ R2 を読み直して埋める。保存の経路(分析の保存・移行・補修)は変えない。
-- 索引は作らない(検証の DO が全件を読む。書き込みの行を増やさない)。
--
--   course_type      芝 / ダ / 障(スナップショットの `race.courseType`。それ以外の値・無い場合は NULL)
--   distance         距離(メートル。正の整数だけ。それ以外は NULL)
--   track_condition  馬場状態の生の値(分析時点。中央は 良・稍・重・不、地方は「−」〈未発表〉もある。空・無い場合は NULL)。表記の正規化は読む側
--   grade            グレードの生の値(G1〜G3・J・G1〜・Jpn1〜・重賞・OP など。#250 より前の分析・グレードなしのレースは NULL で、区別できない)
--   race_name        レース名の生の値(クラスの推定は読む側。#252 より前の地方の分析は空で NULL。長すぎる値〈100 文字超〉は NULL)
--   cond_read        確認の印。NULL = 未確認(検証の DO の補完待ち)。1 = 詳細を読んだ(上の列が NULL なら、スナップショットに無かった)。
--                    0 = 読めなかった(詳細が無い・壊れている・別のレースのもの・R2 に現れないまま猶予切れ)。上の列はすべて NULL。
--                    発走時刻(start_time)と別の印にしたのは、発走時刻が済みの既存分にも条件の補完が要るため。確認済み(NULL でない)の行は上書きしない。
ALTER TABLE analyses ADD COLUMN course_type TEXT;
ALTER TABLE analyses ADD COLUMN distance INTEGER;
ALTER TABLE analyses ADD COLUMN track_condition TEXT;
ALTER TABLE analyses ADD COLUMN grade TEXT;
ALTER TABLE analyses ADD COLUMN race_name TEXT;
ALTER TABLE analyses ADD COLUMN cond_read INTEGER;
