/**
 * アイコン(Issue #244): タブの favicon・見出しの横の画像・apple-touch-icon。
 *
 * 生成物は `icons.generated.ts`(`gen-icons.py` が元画像から作る PNG と ICO の base64)。ここでは配るパスの一覧と、base64 → バイト列の復号だけを持つ。
 * 配信は handler.ts(認証の関門の後ろ・Worker の中から。静的アセット機能は使わない=認証を素通りする経路を作らない。`/app.js` と同じ流儀)。
 * パスの一覧 {@link ICON_PATHS} は route-policy.ts の表と共有する(**閲覧者(GET・HEAD)にも開く**。表に足し忘れるとアイコンが 403 になる)。
 */
import { ICON_ASSETS } from "./icons.generated";

/**
 * 配るアイコンのパス(7 本)。見出し用(全体の絵 A)が `header-32/64/96`、タブの favicon(「穴」だけの C)が `favicon-16/32`、
 * `apple-touch-icon.png`(A の 180px)、`/favicon.ico`(C の 16・32・48 を束ねた ICO。ブラウザが `<link>` の無い文脈で自動で取りにくる)。
 * 手書きの一覧にしてあるのは、生成物にキーが足りなくても表(route-policy.ts)の形が変わらないようにするため(足りなければ test/icons.test.ts が落ちる)。
 */
export const ICON_PATHS: readonly string[] = [
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icons/favicon-16.png",
  "/icons/favicon-32.png",
  "/icons/header-32.png",
  "/icons/header-64.png",
  "/icons/header-96.png",
];

/**
 * アイコンの `Cache-Control`。**他の応答の `no-store`(SECURITY_HEADERS)は使わない**: 変わらない画像を毎回取り直させないため。
 * `private`(共有キャッシュに置かない)・1 日。画像を差し替えたときは、最長 1 日は古い表示が残りうる。
 */
export const ICON_CACHE_CONTROL = "private, max-age=86400";

export interface IconAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const decoded = new Map<string, IconAsset>();

/** `pathname` のアイコン(完全一致。大文字・末尾のスラッシュ・クエリ込みの文字列は一致しない)。無ければ undefined。復号は初回だけ(isolate の中で使い回す)。 */
export function iconAsset(pathname: string): IconAsset | undefined {
  if (!ICON_PATHS.includes(pathname)) {
    return undefined;
  }
  const cached = decoded.get(pathname);
  if (cached !== undefined) {
    return cached;
  }
  const source = ICON_ASSETS[pathname];
  if (source === undefined) {
    return undefined;
  }
  const binary = atob(source.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const asset: IconAsset = { bytes, contentType: source.contentType };
  decoded.set(pathname, asset);
  return asset;
}
