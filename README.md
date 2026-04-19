# drug-ocr-extension

[drug-ocr](https://github.com/hidemasa658/drug-ocr) のコンパニオンとなる Chrome 拡張機能。抽出済みの医薬品名をサイドパネルで閲覧し、他タブの入力欄へワンクリックで転写します。

## 機能

- 📊 サイドパネルに直近24時間の抽出履歴を表示（okusuri.duckdns.org/records をfetch）
- ＋ ボタンで、直前にフォーカスしていたアクティブタブの入力欄（input / textarea / contenteditable）へ貼り付け
- 📋 各薬名を個別にクリップボードコピー
- ⚙️ デバッグモード / エラーログ表示（chrome.storage.local に直近100件保持）
- 🔁 30秒ごとに自動更新

## インストール

1. Chrome で `chrome://extensions/` を開く
2. 右上の「**デベロッパーモード**」を ON
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
4. このリポジトリのクローン/ダウンロードしたフォルダを選択

## 使い方

1. 転写先のタブを開いて、入力欄をクリック（フォーカス）
2. 拡張アイコンをクリック → サイドパネル表示
3. 履歴中の薬名の `＋` をクリック → 直前のタブのフォーカス入力欄に書き込み

## 注意

- Chrome 114+（Side Panel API 必須）
- okusuri.duckdns.org への IP 制限下にあるネットワークからのみ動作
- `chrome://`, `about:`, 拡張ストア等の特殊ページには書き込めません

## ファイル構成

- `manifest.json` — Manifest V3
- `background.js` — サービスワーカー（アイコンクリックでパネル開く設定）
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — サイドパネル本体
- `logo_yoko.png` / `icons/` — ブランドアセット

## ライセンス

個人用途。
