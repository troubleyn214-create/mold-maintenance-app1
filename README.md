# 金型管理アプリ

金型名称とメンテナンス履歴（実施日・内容・ショット数）を、QRコードから確認・更新するWebアプリです。

## スマホから使う

次の公開URLをスマホのブラウザで開いてください。

`https://mold-maintenance-app1.onrender.com`

金型詳細画面で表示・印刷するQRコードには、この公開URLが自動で入ります。PCを起動していなくても利用できます。

## 更新方法

GitHubの `main` ブランチへ変更を保存すると、Renderが自動で再公開します。

## Renderの設定

- Web Service: Freeプラン / Node
- Build Command: `npm install`
- Start Command: `node server.js`
- 環境変数: `DATABASE_URL` にRender PostgreSQLのInternal Database URLを設定

## 注意

Renderの無料Webサービスは未使用時に停止し、最初のアクセスに少し時間がかかることがあります。無料PostgreSQLデータベースは **2026年8月31日** に削除予定のため、継続利用する場合は期限前に有料プランへの変更またはデータ移行が必要です。
