# 包括的コードレビュー

## 1. アーキテクチャ・設計

### 全体構成
Vonage Voice API + OpenAI Realtime API を組み合わせた AI 電話受付システム。Fastify をベースに WebSocket ブリッジを構築し、MCP (Model Context Protocol) を介した UI ダッシュボードも提供している。

### 評価できる点
- **単一責任の分離**: JWT 生成 (`lib/vonage-jwt.js`)、音声変換 (`lib/audio-converter.js`)、通話転送 (`transfer-call.js`)、天気取得 (`get_weather.js`) が個別モジュールとして切り出されている
- **MCP Apps 統合**: `mcp-server.js` で UI リソースと app-only ツールを分離し、モデルに見せるツールと UI 専用ツールを適切に区別している
- **デプロイパイプライン**: `change-url.js` → `fly deploy` の一連のフローが `npm run deploy` でワンコマンド化されている

### 改善が必要な点

#### [Critical] グローバル状態によるマルチコネクション障害
`index.js:67-68` で `wsOpenAiOpened` と `isProcessingAudio` がモジュールレベルのグローバル変数として宣言されている。複数の同時通話が発生した場合、ある通話の状態変更が別の通話に影響する。

```javascript
// 現状: グローバル変数
let wsOpenAiOpened = false;  // index.js:67
let isProcessingAudio = true; // index.js:68
```

これらは WebSocket コネクションごとの状態として、`/media-stream` ハンドラ内のローカル変数にすべき。

#### [Critical] callRegistry のメモリリーク
`index.js:71` の `callRegistry` は `Map` だが、通話終了後にエントリを削除する処理がない。長時間稼働するとメモリが際限なく増加する。TTL 付きの削除処理や最大保持件数の制限が必要。

#### [Medium] index.js の肥大化
`index.js` は 651 行あり、以下の責務が混在している:
- HTTP エンドポイント定義
- WebSocket ハンドリング
- OpenAI Realtime セッション管理
- Function Calling のディスパッチ・実行
- 通話レジストリ管理

Function Calling のディスパッチ部分 (502-603行) だけでも 100 行を超えており、別モジュールに抽出すべき。

---

## 2. セキュリティ

### 評価できる点
- `/connect` エンドポイントで API キーによる認証を実施 (`index.js:134-143`)
- `.gitignore` で `.env`, `private.key` を除外
- `.dockerignore` で秘密鍵やシークレットを除外

### 改善が必要な点

#### [Critical] WebSocket エンドポイントの認証欠如
`/media-stream` WebSocket エンドポイント (`index.js:239`) には認証が一切ない。URI に含まれるクエリパラメータ (`caller`, `called`, `uuid`) も検証されない。Vonage からの接続以外のアクセスを防ぐ手段がなく、任意のクライアントが接続して OpenAI API を不正利用できる。

#### [Critical] API キー認証の設計上の問題
`/connect` エンドポイント (`index.js:142`) では `VONAGE_APPLICATION_ID` を API キーとして使用している。Application ID は秘密情報ではなく、Vonage のドキュメントや Webhook ペイロードに含まれる可能性がある。専用の API キーを別途設定すべき。

#### [High] XSS 脆弱性 (HTML UI)
`call-monitor.html:230-266` でユーザー入力（通話のトランスクリプト、電話番号、ユーザー名）を `innerHTML` で直接レンダリングしている。悪意のある発信者が音声認識経由で `<script>` タグを含む発言をした場合、XSS が成立する可能性がある。

```javascript
// call-monitor.html:252-256 - エスケープなしの innerHTML 挿入
${call.transcripts.map(t => `
  <div class="transcript-line">
    <span class="role ${t.role}">${t.role === 'user' ? '発信者' : 'AI'}:</span>
    <span>${t.text}</span>  // ← エスケープなし
  </div>
`).join('')}
```

`textContent` への代入か、HTML エスケープ処理が必要。

#### [Medium] NCCO WebSocket URI でのクエリパラメータインジェクション
`index.js:227` で `caller`, `called`, `uuid` をエスケープせずに WebSocket URI に埋め込んでいる。

```javascript
uri: `wss://${SERVER_URL}/media-stream?caller=${caller}&called=${called}&uuid=${uuid}`
```

`encodeURIComponent()` でのエスケープが必要。

#### [Medium] JWT の console.log 出力
`index.js:159` で JWT トークンをログに出力している。本番環境でもこのログが出力されるため、ログ収集システム経由でトークンが漏洩するリスクがある。

```javascript
console.log('Vonage JWT を生成しました', jwtToken); // index.js:159
```

---

## 3. バグ・ロジックの問題

#### [Critical] voice プロパティの重複定義
`index.js:280-281` で `voice` プロパティが2回定義されている。後の値で上書きされるため実害はないが、意図しないバグの原因となる。

```javascript
voice: 'alloy',
voice: 'alloy',  // 重複
```

#### [High] elapsedTime の計算ロジック
`index.js:447-448` で `response.audio_start_ms` と `responseStartTimestamp` を比較しているが、`audio_start_ms` は OpenAI のレスポンス内のオフセット値であり、`responseStartTimestamp` は `Date.now()` のエポックミリ秒。異なる時間軸の値を引き算しており、計算結果は意味のない値になる。

```javascript
if (responseStartTimestamp && response.audio_start_ms) {
  elapsedTime = response.audio_start_ms - responseStartTimestamp;
  // audio_start_ms: OpenAI内部のオフセット (数百〜数千ms)
  // responseStartTimestamp: Date.now() (1700000000000+ ms)
  // → 結果は大きな負の値 → 500にクランプされる
}
```

#### [Medium] /answer のテスト期待値と実装の不一致
`index.js:227` では `caller`, `called`, `uuid` がクエリパラメータとして WebSocket URI に付与されるが、テスト (`test/index.test.js:48`) ではクエリパラメータなしの URI を期待している。テストがパスするのは `from`, `to`, `uuid` が undefined のとき `caller=undefined` 等になるため。テスト側で適切な入力を与えるべき。

#### [Medium] エラー時の OpenAI 接続リーク
`index.js:263` で OpenAI WebSocket を接続開始するが、接続中にエラーが発生した場合のクリーンアップが不十分。`openAiWs.on('error')` (`index.js:634`) ではログ出力のみで、Vonage 側の接続を閉じる処理がない。

#### [Low] コメントアウトされたコード
`index.js:94-95` にコメントアウトされた古い `SYSTEM_MESSAGE` 定義が残っている。また `index.js:257` にコメントアウトされた `responseId` 変数がある。

---

## 4. パフォーマンス・スケーラビリティ

#### [High] 音声データの逐次 JSON エンコード
`index.js:388-392` で受信した各音声チャンクを毎回 `JSON.stringify` で OpenAI に送信している。高頻度の音声ストリームでは GC 圧力が高くなる。バッファリングの最適化を検討すべき。

#### [Medium] system-message.txt の同期読み込み
`index.js:78` で `fs.readFileSync` を使用している。起動時の一度きりなので問題は小さいが、`vonage-jwt.js:23` でも鍵ファイルを同期読み込みしている。

#### [Medium] callRegistry の無制限成長
前述のメモリリーク問題と関連するが、`/api/calls` (`index.js:120-123`) で全件ソートして返すため、件数増加に伴いレスポンスが遅くなる。ページネーションが必要。

---

## 5. エラーハンドリング

### 評価できる点
- Function Calling の外側に catch-all のエラーハンドラがある (`index.js:590-602`)
- `transfer-call.js` で UUID の null チェックを実施

### 改善が必要な点

#### [High] OpenAI WebSocket 接続失敗時のハンドリング不足
`index.js:263` で OpenAI への WebSocket 接続を開始するが、接続に失敗した場合（API キーの誤り、レートリミット等）、ユーザーは無限に待たされる。接続タイムアウトやリトライ、Vonage 側への適切なエラー応答が必要。

#### [Medium] `sendSessionUpdate` のタイミング依存
`index.js:349` で `setTimeout(sendSessionUpdate, 250)` としているが、250ms が十分な保証にならない場合がある。OpenAI の `session.created` イベントを待ってからセッション更新を送るべき。

#### [Medium] putName の戻り値未使用
`index.js:524` で `await putName(name)` を呼んでいるが、`putName` (`put_name.js:7-14`) はバリデーション失敗時に例外を投げず、`return` するだけ。呼び出し側は成功を前提としている。

---

## 6. テスト

### 現状
- `test/index.test.js`: 7テストケース（ヘルスチェック、NCCO応答、認証）
- `test/audio-converter.test.js`: 2テストケース（正常変換、バリデーション）

### 改善が必要な点

#### [High] テストカバレッジの不足
以下の重要なロジックにテストがない:
- WebSocket ハンドリング（メインのビジネスロジック）
- Function Calling のディスパッチと実行
- `transfer-call.js` のAPI呼び出し
- `get_weather.js` の天気情報取得
- `mcp-server.js` の全機能
- `callRegistry` の状態管理
- `vonage-jwt.js` のJWT生成

#### [Medium] /answer テストの不正確さ
`test/index.test.js:34-53` のテストでは入力パラメータ (`from`, `to`, `uuid`) を与えていないため、NCCO レスポンスの WebSocket URI に `caller=undefined` が含まれる。実際の動作と異なるテストになっている。

#### [Low] テストの独立性
`test/index.test.js:5` で `../index.js` をインポートしているが、`index.js` は起動時に環境変数チェック (`index.js:32-35`) を行う。テスト環境で `OPENAI_MODEL`, `SERVER_URL`, `OPENAI_API_KEY` が設定されていない場合 `process.exit(1)` で即座にプロセスが終了する。

---

## 7. コード品質・保守性

#### [Medium] McpApp クラスの重複
3つの HTML ファイル (`call-monitor.html`, `outbound-call.html`, `transfer-dialog.html`) それぞれに同一の `McpApp` クラスが重複実装されている。共通の JS ファイルとして切り出すか、ビルドステップで注入すべき。

#### [Medium] マジックナンバー
- `index.js:349`: `setTimeout(sendSessionUpdate, 250)` - 250ms の根拠が不明
- `index.js:356`: `setTimeout(..., 1000)` - 1秒の根拠が不明
- `index.js:429`: `960` バイト - コメントはあるが定数化されていない
- `index.js:452-458`: `500`, `5000` のクランプ値 - 定数化されていない

#### [Low] ログレベルの未分化
`console.log`, `console.error`, `console.warn`, `console.debug` が混在しているが、体系的なログレベル管理がない。本番環境でのデバッグログ抑制ができない。構造化ログライブラリ (pino 等、Fastify との親和性が高い) の導入を検討すべき。

#### [Low] node-fetch の不要な使用
Node.js 18+ には組み込みの `fetch` がある。`package.json` で Node.js 20.18.1 を使用しているため、`node-fetch` 依存は削除可能。ただし `mcp-server.js:34` では既に組み込み `fetch` を使用しており、一貫性がない。

---

## 8. デプロイ・運用

### 評価できる点
- Dockerfile がマルチステージビルドで最適化されている
- Fly.io の `auto_stop_machines` でコスト最適化
- GitHub Actions による CD パイプライン

### 改善が必要な点

#### [Medium] CI パイプラインにテストがない
`.github/workflows/fly-deploy.yml` はデプロイのみ実行し、テストを含まない。`main` ブランチへのプッシュで直接デプロイされるため、壊れたコードが本番に到達する可能性がある。

#### [Medium] ヘルスチェックの不十分さ
`/_/health` (`index.js:103-105`) は常に `OK` を返す。OpenAI API への接続状態や、必要な環境変数の設定状況を含むヘルスチェックが望ましい。

#### [Low] デフォルトブランチの不一致
`fly-deploy.yml` は `main` ブランチをトリガーにしているが、リポジトリのデフォルトブランチは `master`。

---

## 9. 優先度別サマリー

### Critical（即時対応推奨）
1. **グローバル状態変数** (`wsOpenAiOpened`, `isProcessingAudio`) による同時通話障害
2. **callRegistry のメモリリーク** - 長時間稼働で OOM の原因
3. **WebSocket の認証欠如** - OpenAI API の不正利用リスク
4. **API キーとして VONAGE_APPLICATION_ID を使用** - 秘密でない値での認証

### High（早期対応推奨）
5. **XSS 脆弱性** - HTML UI でのエスケープ不足
6. **elapsedTime の計算バグ** - 異なる時間軸の値の混在
7. **OpenAI 接続失敗時のハンドリング不足**
8. **テストカバレッジの大幅な不足**

### Medium（計画的に対応）
9. URI パラメータのエスケープ不足
10. JWT のログ出力
11. index.js の責務分離
12. CI にテスト追加
13. McpApp クラスの重複排除
14. callRegistry のページネーション

### Low（余裕があれば対応）
15. コメントアウトされたコード削除
16. ログレベルの体系化
17. node-fetch の削除
18. デフォルトブランチの統一
