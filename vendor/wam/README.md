# vendor/wam — 同梱 Web Audio Modules

プラグイン音源とホストSDKの同梱コピー。以前は mainline.i3s.unice.fr（ニース大学の
デモサーバー）から動的ロードしていたが、サーバーダウンでアプリの音源機能が
止まるため、同一オリジン配信に切り替えた（2026-07-16）。

## 出所（コミット固定）

- `obxd/ tinySynth/ faustFlute/` —
  https://github.com/webaudiomodules/wam-examples
  @ `2179e50cf7bbc1f038a6e423651d9915505621f8`（MIT、LICENSE-wam-examples.txt 参照）
- `sdk/` — https://github.com/webaudiomodules/sdk
  @ `d425ee7ec0479b2a2ee0940374242356997b8ba6`
- `../mqtt.min.js` — https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js（MIT）

除外: `*.d.ts` `*.map`（実行時に不要）

## 注意

- プラグインは `../sdk/src/...` を相対 import するため、`sdk/` は
  プラグインディレクトリの兄弟に置くこと（この配置を崩さない）。
- 更新するときは上記リポジトリの新しいコミットから同じ手順で取り直す。
