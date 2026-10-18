import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// distディレクトリの解決（開発ルート scripts/../dist または 配布パッケージ app/dist）
const candidateDistDirs = [
  path.resolve(__dirname, 'dist'),
  path.resolve(__dirname, '../dist'),
];
const distDir = candidateDistDirs.find((d) => fs.existsSync(path.join(d, 'index.html'))) || candidateDistDirs[1];

const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1';
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 8765);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};



export function createRequestHandler({
  distDir = path.resolve(__dirname, '../dist'),
  host = HOST,
  port = PORT,
  gatewayPort = GATEWAY_PORT,
} = {}) {
  return (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    let parsedUrl;
    let decodedPath = '/';
    try {
      parsedUrl = new URL(req.url || '/', `http://${host}:${port}`);
      decodedPath = decodeURIComponent(parsedUrl.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request: Invalid URL');
      return;
    }

    // 1. /v1/* および /health を LLM-Gateway (127.0.0.1:8765) へリバースプロキシ (SSEストリーミング完全透過)
    if (decodedPath.startsWith('/v1') || decodedPath === '/health') {
      const cleanHeaders = { ...req.headers };
      delete cleanHeaders['host'];
      delete cleanHeaders['accept-encoding'];
      delete cleanHeaders['content-length'];
      cleanHeaders['accept-encoding'] = 'identity';
      cleanHeaders['host'] = `127.0.0.1:${gatewayPort}`;

      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: gatewayPort,
          path: decodedPath + parsedUrl.search,
          method: req.method,
          headers: cleanHeaders,
        },
        (proxyRes) => {
          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          }
          proxyRes.pipe(res);
          proxyRes.on('error', () => {
            if (!res.writableEnded) res.end();
          });
        }
      );

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: {
                message: `LLM-Gateway (127.0.0.1:${gatewayPort}) への接続に失敗しました: ${err.message}`,
                type: 'gateway_connection_error',
              },
            })
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      });

      req.on('aborted', () => {
        proxyReq.destroy();
      });

      res.on('close', () => {
        if (!proxyReq.destroyed) {
          proxyReq.destroy();
        }
      });

      req.pipe(proxyReq);
      return;
    }

    // 2. 静的アセット配信 (パストラバーサル防御 + SPAフォールバック)
    const resolvedDistDir = path.resolve(distDir);
    let resolvedFilePath = path.resolve(resolvedDistDir, '.' + path.normalize(decodedPath));

    if (!resolvedFilePath.startsWith(resolvedDistDir)) {
      resolvedFilePath = path.join(resolvedDistDir, 'index.html');
    }

    let filePath = resolvedFilePath;

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(resolvedDistDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
        return;
      }

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  };
}

export function startServer({
  dist = distDir,
  host = HOST,
  port = PORT,
  gatewayPort = GATEWAY_PORT,
} = {}) {
  const handler = createRequestHandler({ distDir: dist, host, port, gatewayPort });
  const srv = http.createServer(handler);

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[起動エラー] ポート ${port} は既に使用されています。`);
      console.error(`ポート ${port} を使用しているプロセスを終了してから再起動してください。\n`);
      process.exit(1);
    } else {
      console.error('\n[サーバー予期せぬエラー]', err);
      process.exit(1);
    }
  });

  return new Promise((resolve) => {
    srv.listen(port, host, () => {
      console.log('============================================================');
      console.log('  FailurePrism (TPDD-Editor & VTA-Editor) 統合Webサーバー');
      console.log(`  Menu URL:      http://${host}:${port}/#menu`);
      console.log(`  TPDD-Editor:   http://${host}:${port}/#tpdd`);
      console.log(`  VTA-Editor:    http://${host}:${port}/#vta`);
      console.log(`  Gateway Proxy: http://${host}:${port}/v1 -> 127.0.0.1:${gatewayPort}`);
      console.log('  ※ 終了する場合は Ctrl+C を押してください。');
      console.log('============================================================\n');
      resolve(srv);
    });
  });
}

// 直接実行時の起動
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('\n[エラー] 配布用ビルドディレクトリ (dist/index.html) が見つかりません。');
    console.error('先に "npm run build" を実行して静的ファイルを生成してください。\n');
    process.exit(1);
  }
  startServer();
}
