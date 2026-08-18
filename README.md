# ショット数管理アプリ

生産終了・段取りのタイミングで金型のQRコードを読み取り、現場の金型カウンターに表示された累計値を入力するWebアプリです。サーバーが直前の累計との差分を計算し、履歴へ保存します。

## 主な機能

- 金型の登録
- 金型ごとのQRコード生成・印刷
- スマートフォンでのQRコード読み取り
- 生産日・金型カウンター累計値・任意メモの記録
- 累計ショット数と入力履歴の表示
- 二重送信・通信再送による重複加算の防止
- メンテ実施内容と実施時点の累計ショット数を記録
- スマホ向け縦長グラフでショット数とメンテの推移を表示

## 環境変数

- `DATABASE_URL`: PostgreSQL接続文字列（必須）
- `PUBLIC_BASE_URL`: 公開URL（任意。QRコードへ埋め込むURL）
- `PORT`: ポート番号（任意）

秘密情報はリポジトリへ保存せず、Renderまたはローカル環境の環境変数へ設定してください。

## 起動

```bash
npm install
npm start
```

## 新規DBの初期化

空のPostgreSQLへ、次の順で適用します。

1. `migrations/000_shot_schema.sql`
2. `migrations/001_p0_nullable.sql`
3. staging用の会社・ユーザーを作成し、既存データがある場合は会社ID・操作者IDを補完
4. `migrations/002_p0_constraints.sql`
5. `migrations/003_counter_idempotency.sql`
6. `migrations/004_maintenance_records.sql`

パスワードや接続文字列はSQL・リポジトリへ保存しません。

## 現行アプリとの分離

この版は `shot_molds` と `shot_records` を使用し、現行の金型メンテナンス版が使う `molds` と `maintenance_logs` は変更しません。2026-08-15時点のRender環境では新旧サービスが同じNeon DBへ接続しているため、P0本番反映前にショット数管理専用DBへ分離します。

## 今後の候補

- メンテナンス基準ショット数と到達警告
- 入力履歴の訂正・取消
- CSV出力
