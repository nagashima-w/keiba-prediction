// core-combo-bet-allocation-export.test.ts が esbuild で束ねるための合成エントリ。
// renderer(packages/app/src/renderer/**)配下のファイルではない(機能D-2c第1段はrenderer配線を
// 一切行わないスコープのため)。@keiba/core の新規サブパスエクスポート(./ev/combo-bet-allocation、
// Issue #28)が browser platform で native/node 依存を引き込まずに束ねられることだけを確認する。
export {
  allocateGeneralBets,
  buildComboCandidates,
  DEFAULT_EV_CONFIG,
} from "@keiba/core/ev/combo-bet-allocation";
