# delivery-note-system

Render にそのまま置ける、納品書電子化の最小実用セットです。

## 含まれるもの
- `server.js` : Express API本体
- `schema.sql` : PostgreSQL テーブル作成SQL
- `public/order.html` : 得意先注文画面
- `public/admin.html` : 管理画面
- `public/sign.html` : 受領サイン画面
- `public/portal.html` : 得意先履歴画面
- `.env.example` : Render 環境変数例

## Render 手順
1. 新規 Web Service を作成
2. GitHub にこの一式を push
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment Variables を設定
   - `DATABASE_URL`
   - `APP_BASE_URL`
   - `ADMIN_BASIC_USER`
   - `ADMIN_BASIC_PASS`
   - `COMPANY_NAME`
6. PostgreSQL に `schema.sql` を流す

## 初期画面
- `/public/order.html` 注文画面
- `/public/admin.html` 管理画面
- `/public/portal.html` 納品履歴

## 使い方
1. 注文画面で注文作成
2. 管理画面で注文一覧を開く
3. 「納品書発行」で納品書URLを作る
4. 納品時に `view_url` を見せる
5. 必要なら `sign_url` で受領サイン
6. 履歴画面から後で確認

## 注意
- 管理画面は Basic認証です
- PDFはブラウザ印刷を使う設計です
- 本番では customer_code だけで履歴表示せず、LINEログインや強いトークンにしてください
