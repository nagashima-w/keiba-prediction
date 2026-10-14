#!/usr/bin/env python3
"""
元画像(利用者が作った「穴馬」のアイコン。1850x1758 の JPEG)から、web 画面のアイコンを作り、Worker が配る TS(src/icons.generated.ts)に書き出す(Issue #244)。

使い方(cloud/ で。Pillow が要る。依存はリポジトリに入れない: `python3 -m venv /tmp/iconvenv && /tmp/iconvenv/bin/pip install pillow`):
    /tmp/iconvenv/bin/python gen-icons.py <元画像のパス> [--dump <PNG を書き出すフォルダ>]
元画像はリポジトリに入れない(370KB で履歴が膨らむ。差し替える予定もない)。生成物 src/icons.generated.ts だけをコミットする。
CI は cloud だけを install し Python を使わないので、生成物とこのスクリプトの一致は検査しない。代わりに test/icons.test.ts が寸法・形式・大きさを固定する。

切り抜きと縮小(座標は元画像のピクセル。docs/current-spec.md にも同じ内容を書いている):
  A(全体)    : crop(46, 0, 1804, 1758) の正方形(左右を 46px ずつ落とす)→ 32・64・96・180 px。見出しの横(32/64/96)と apple-touch-icon(180)。
  C(「穴」だけ): crop(100, 520, 830, 1220)(730x700)を、背景色で 730x730 の正方形に埋める(縦の中央に置く)→ 16・32・48 px。
                 16px では全体の絵だと「馬」の横線やドリル・火花がつぶれるので、タブの favicon は「穴」だけにする。
  背景色      : 元画像の外周(4 辺のすべての画素)の、チャンネルごとの中央値。JPEG のノイズで端の画素は #ff7803 から 1 ずれることがあるため、1 画素ではなく中央値を採る。
  縮小        : Pillow の Image.LANCZOS。PNG は RGB・optimize=True(出力は決定的)。
  /favicon.ico: C の 16・32・48 の PNG を、PNG 圧縮のエントリのまま束ねた ICO(ブラウザは <link> が無い文脈で /favicon.ico を自動で取りにくる)。
"""
import argparse
import base64
import io
import os
import statistics
import struct
import sys

import PIL
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(HERE, "src", "icons.generated.ts")

A_CROP = (46, 0, 1804, 1758)
C_CROP = (100, 520, 830, 1220)
A_SIZES = (32, 64, 96, 180)
C_SIZES = (16, 32, 48)


def border_background(image: Image.Image) -> tuple:
    """元画像の外周(4 辺)の画素の、チャンネルごとの中央値。"""
    width, height = image.size
    pixels = image.load()
    edge = [pixels[x, y] for x in range(width) for y in (0, height - 1)]
    edge += [pixels[x, y] for y in range(height) for x in (0, width - 1)]
    return tuple(int(statistics.median(p[c] for p in edge)) for c in range(3))


def to_png(image: Image.Image, size: int) -> bytes:
    resized = image.resize((size, size), Image.LANCZOS)
    buffer = io.BytesIO()
    resized.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def make_ico(pngs: list) -> bytes:
    """PNG 圧縮のエントリを束ねた ICO。`pngs` は (一辺, PNG のバイト列) の並び。"""
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    directory = b""
    body = b""
    for size, data in pngs:
        directory += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)
    return header + directory + body


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", help="元画像(JPEG)のパス")
    parser.add_argument("--dump", help="確認用に、生成した PNG・ICO を書き出すフォルダ")
    args = parser.parse_args()

    source = Image.open(args.source).convert("RGB")
    if source.size != (1850, 1758):
        print(f"元画像の大きさが想定(1850x1758)と違います: {source.size}", file=sys.stderr)
        return 1

    background = border_background(source)
    a_image = source.crop(A_CROP)
    c_crop = source.crop(C_CROP)
    side = max(c_crop.size)
    c_image = Image.new("RGB", (side, side), background)
    c_image.paste(c_crop, ((side - c_crop.width) // 2, (side - c_crop.height) // 2))

    header = {size: to_png(a_image, size) for size in A_SIZES}
    favicon = {size: to_png(c_image, size) for size in C_SIZES}
    assets = [
        ("/favicon.ico", "image/x-icon", make_ico([(size, favicon[size]) for size in C_SIZES])),
        ("/apple-touch-icon.png", "image/png", header[180]),
        ("/icons/favicon-16.png", "image/png", favicon[16]),
        ("/icons/favicon-32.png", "image/png", favicon[32]),
        ("/icons/header-32.png", "image/png", header[32]),
        ("/icons/header-64.png", "image/png", header[64]),
        ("/icons/header-96.png", "image/png", header[96]),
    ]

    lines = [
        "// ★生成物。手で編集しない。再生成: cloud/ で `python gen-icons.py <元画像>`(gen-icons.py。手順は cloud/README.md)。",
        "// 元画像(「穴馬」のアイコン)から切り抜いて縮小した PNG と ICO の base64。Worker が認証の後ろで配る(Issue #244)。形式・寸法・大きさは test/icons.test.ts が固定している。",
        f"// 生成に使った Pillow: {PIL.__version__}。背景色(元画像の外周の中央値): #{background[0]:02x}{background[1]:02x}{background[2]:02x}。",
        "export const ICON_ASSETS: Readonly<Record<string, { readonly contentType: string; readonly base64: string }>> = {",
    ]
    for path, content_type, data in assets:
        lines.append(f'  "{path}": {{ contentType: "{content_type}", base64: "{base64.b64encode(data).decode("ascii")}" }},')
    lines.append("};")
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    if args.dump:
        os.makedirs(args.dump, exist_ok=True)
        for path, _, data in assets:
            with open(os.path.join(args.dump, path.strip("/").replace("/", "_")), "wb") as f:
                f.write(data)

    print(f"生成しました: {os.path.relpath(OUTPUT, HERE)}(背景色 #{background[0]:02x}{background[1]:02x}{background[2]:02x}, Pillow {PIL.__version__})")
    for path, _, data in assets:
        print(f"  {path}: {len(data)} バイト")
    return 0


if __name__ == "__main__":
    sys.exit(main())
