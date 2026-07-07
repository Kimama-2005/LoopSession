# 静的サーバー。Windows の http.server は .js を text/plain で返してしまい
# ブラウザが ES モジュールの実行を拒否するため、MIME タイプを明示して配信する。
import http.server

PORT = 5173


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json",
    }

    # 開発用サーバーなのでキャッシュさせない（MIME 修正前の古い応答が残るのを防ぐ）
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


# ThreadingHTTPServer を使う。keep-alive 接続を複数さばくため
# （単一スレッドの TCPServer だと ES モジュールの並行取得でデッドロックする）。
http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(("", PORT), Handler) as httpd:
    print(f"LoopSession serving on http://localhost:{PORT}")
    httpd.serve_forever()
