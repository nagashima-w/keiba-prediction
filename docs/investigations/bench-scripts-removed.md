# 速度計測スクリプト 4 本の削除と、再現の手順(Issue #395。#390 D-4)

配分計算まわりの速度計測(`scripts/bench-*`)のうち、役目を終えた 4 本をコードから消した(ユーザー決定・2026-10-19)。
**再現するには、削除の直前の公開済みコミット `46410ab` を checkout する。**

```sh
git checkout 46410ab
pnpm install --frozen-lockfile
pnpm tsx scripts/bench-allocation.ts        # 例。4 本とも、ネットワークに出ない決定的な計測
```

(`46410ab` は `Issue #393`〈#390 R-2〉の公開コミット。6 本の bench は、このコミットに全部ある。確認: `git ls-tree --name-only 46410ab scripts/ | grep bench`。)

## 消した 4 本

| スクリプト | 何を測ったか | 行数 |
|---|---|---|
| `scripts/bench-allocation.ts` | 券種一般の配分最適化(`combo-bet-allocation.ts`)の性能。複勝・ワイド・3連複の全点正 EV の regime と、`candidateCap` の有無の比較(機能 D-2a・#14) | 215 |
| `scripts/bench-run-greedy-allocation.ts` | `runGreedyAllocation`(`allocation-primitives.ts`)単体の、フェーズ別の内訳(#107・#24-C) | 809 |
| `scripts/bench-trifecta-allocation.ts` | 三連単を含む配分計算の所要時間・候補数・`candidateCap` による切り捨て(#129・#25-C)。`bench-mixed-allocation.ts` の `loadAnalysisResult` を import していた | 1,147 |
| `scripts/bench-combo-odds-key.ts` | `buildComboOddsCellMap` の自己防御(検証)の有無による実行時間の差(#32) | 112 |

合計 2,283 行(`git show 46410ab:scripts/<名前>.ts | wc -l` で各行数を再現できる)。

## 残した 2 本とその理由

- `scripts/bench-joint-model.ts`: open な #84(Plackett-Luce の非収束)の材料。`prior-normalization-258/report.md` も、この bench の合成分布の値を引用している。
- `scripts/bench-mixed-allocation.ts`: open な #36(貪欲法の刻み幅 `greedySteps` が券種構成比を左右する)の材料(greedySteps の感度表)。
  `bench-trifecta-allocation.ts` はこれを import していたが、import する側を消したので、残す側に影響は無い(`scripts/test/probability-quality-regression.test.ts` の JSDoc が名前を挙げるだけで、import はしない)。

## 運用で使うものは無傷

`dump-race.ts`・`fetch-fixtures.ts`・`measure-d1-size.ts`・`measure-verify.ts` などは bench を import していない。
削除前に、4 本それぞれについて、`scripts/`・`packages/`・`cloud/`・`.github/` からの import と、open な Issue(本文の `bench` の語)が無いことを確かめた
(`git grep -n "from \".*bench-"` の結果は、削除した 4 本のうち `bench-trifecta-allocation.ts` が `bench-mixed-allocation.ts` を import する 1 行だけだった)。

## 削除後に「ファイルが無い」ことになる、名指しの参照(コードは触っていない。散文)

JSDoc・コメント・文書が、消した 4 本を「再現コマンド」として名指ししている。上の手順(`git checkout 46410ab`)で再現できる。
一覧は `git grep -n "bench-allocation\|bench-run-greedy-allocation\|bench-trifecta-allocation\|bench-combo-odds-key"` で再現する(`scripts/` 内の削除した 4 本自身を除く)。表の行番号は 2026-10-21 に取り直した(`docs/issue-order.md` は追記で動くので、ずれたらこの grep で取り直す)。

| 消した bench | 名指ししている場所(ファイル:行) |
|---|---|
| `bench-allocation` | `packages/core/src/ev/allocation-primitives.ts`:294・296・442 / `packages/core/src/ev/combo-bet-allocation.ts`:532 / `packages/core/src/scraper/combo-odds-key.ts`:419 / `packages/core/test/ev/combo-bet-allocation.test.ts`:1450 / `docs/issue-order.md`:962 / `.claude/agents/code-reviewer.md`:126 / `scripts/bench-joint-model.ts`:12 / `scripts/bench-mixed-allocation.ts`:22 / `scripts/fetch-nar-trio-axis-fixture.ts`:5 |
| `bench-run-greedy-allocation` | `packages/core/src/ev/allocation-primitives.ts`:371・437・444 / `packages/core/test/ev/allocation-primitives.test.ts`:565 / `docs/issue-order.md`:881 / `docs/versioning.md`:1367 |
| `bench-trifecta-allocation` | `packages/core/src/ev/combo-bet-allocation.ts`:563 / `docs/trifecta-odds-investigation.md`:460・462・554 / `docs/versioning.md`:1830・1918 / `docs/issue-order.md`:843・845 / `scripts/fetch-trifecta-18horse-snapshot.ts`:5 |
| `bench-combo-odds-key` | `packages/core/src/scraper/combo-odds-key.ts`:419 / `scripts/fetch-nar-trio-axis-fixture.ts`:5 |

行番号は、この文書を書いた時点(削除の直前)のもの。後の編集でずれる。**JSDoc は書き換えていない**(挙動を変えない作業の中で、広くコメントを触らないため)。
