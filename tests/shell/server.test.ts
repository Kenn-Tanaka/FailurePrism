import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequestHandler } from '../../scripts/server.mjs';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('scripts/server.mjs - Proxy Resiliency & Dist-Independent Static Serving (Issue 7, R2-4, R2-5)', () => {
  let tempDistDir: string;
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let proxyServer: http.Server;
  let proxyPort: number;
  let handler: ReturnType<typeof createRequestHandler>;
  let receivedUpstreamRequests: Array<{ method?: string; url?: string; body: string }> = [];

  beforeAll(async () => {
    // R2-5: Create an isolated temporary dist directory with a minimal index.html
    tempDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failureprism-server-test-'));
    fs.writeFileSync(
      path.join(tempDistDir, 'index.html'),
      '<!doctype html><html><head><title>FailurePrism Test</title></head><body><div id="root"></div></body></html>',
      'utf-8'
    );

    // Start mock upstream gateway server on an ephemeral port
    upstreamServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        receivedUpstreamRequests.push({
          method: req.method,
          url: req.url,
          body,
        });

        if (req.url?.startsWith('/v1/sse')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('data: {"chunk":1}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            upstreamUrl: req.url,
            method: req.method,
            receivedBody: body ? JSON.parse(body) : null,
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        const addr = upstreamServer.address();
        upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    handler = createRequestHandler({
      distDir: tempDistDir,
      host: '127.0.0.1',
      port: 3000,
      gatewayPort: upstreamPort,
    });

    proxyServer = http.createServer(handler);
    await new Promise<void>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => {
        const addr = proxyServer.address();
        proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    if (tempDistDir && fs.existsSync(tempDistDir)) {
      fs.rmSync(tempDistDir, { recursive: true, force: true });
    }
  });

  function createMockRes() {
    let statusCode = 200;
    const headers: Record<string, any> = {};
    let body = '';
    return {
      headersSent: false,
      writableEnded: false,
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      writeHead: function (code: number, h?: any) {
        statusCode = code;
        this.headersSent = true;
        if (h) Object.assign(headers, h);
      },
      end: function (chunk?: any) {
        if (chunk) body += chunk.toString();
        this.writableEnded = true;
      },
      on: vi.fn(),
      getStatusCode: () => statusCode,
      getHeaders: () => headers,
      getBody: () => body,
    };
  }

  it('safely catches malformed absolute-form URLs (e.g. http://[ and http://example.com/v1) with 400 Bad Request', () => {
    for (const badUrl of ['http://[', 'http://example.com/v1/models', '//evil.example/v1']) {
      const req: any = {
        url: badUrl,
        method: 'GET',
        headers: {},
        pipe: vi.fn(),
        on: vi.fn(),
      };
      const res = createMockRes();

      expect(() => {
        handler(req, res as any);
      }).not.toThrow();

      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toContain('400 Bad Request: Invalid URL');
    }
  });

  it('safely catches malformed percent encoding on both static and /v1 routes with 400 Bad Request', () => {
    for (const badPath of ['/test%E0%A4%A', '/v1/%E0%A4%A']) {
      const req: any = {
        url: badPath,
        method: 'GET',
        headers: {},
        pipe: vi.fn(),
        on: vi.fn(),
      };
      const res = createMockRes();

      expect(() => {
        handler(req, res as any);
      }).not.toThrow();

      expect(res.getStatusCode()).toBe(400);
    }
  });

  it('rejects /v1/%0A (encoded control character) with 400 Bad Request without throwing ERR_UNESCAPED_CHARACTERS', () => {
    const req: any = {
      url: '/v1/%0A',
      method: 'GET',
      headers: {},
      pipe: vi.fn(),
      on: vi.fn(),
    };
    const res = createMockRes();

    expect(() => {
      handler(req, res as any);
    }).not.toThrow();

    expect(res.getStatusCode()).toBe(400);
  });

  it('catches synchronous http.request exceptions (e.g. invalid header characters) and responds with 400 Bad Request', () => {
    const req: any = {
      url: '/v1/models',
      method: 'GET',
      headers: {
        'x-bad-header': 'bad\r\nvalue',
      },
      pipe: vi.fn(),
      on: vi.fn(),
    };
    const res = createMockRes();

    expect(() => {
      handler(req, res as any);
    }).not.toThrow();

    expect(res.getStatusCode()).toBe(400);
  });

  it('forwards /v1/%E6%97%A5 (percent-encoded UTF-8) and query strings to upstream without crashing', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/%E6%97%A5?lang=ja&limit=5`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.upstreamUrl).toBe('/v1/%E6%97%A5?lang=ja&limit=5');
  });

  it('forwards normal JSON POST requests and SSE streams cleanly after invalid requests', async () => {
    // 1. JSON POST request
    const postRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(postRes.status).toBe(200);
    const postData = await postRes.json();
    expect(postData.ok).toBe(true);
    expect(postData.upstreamUrl).toBe('/v1/chat/completions');
    expect(postData.receivedBody).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    // 2. SSE streaming request
    const sseRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/sse`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    const sseText = await sseRes.text();
    expect(sseText).toContain('data: {"chunk":1}');
    expect(sseText).toContain('data: [DONE]');

    // 3. Static HTML fallback from isolated tempDistDir
    const htmlRes = await fetch(`http://127.0.0.1:${proxyPort}/`);
    expect(htmlRes.status).toBe(200);
    const htmlText = await htmlRes.text();
    expect(htmlText.toLowerCase()).toContain('<!doctype html>');
    expect(htmlText).toContain('FailurePrism Test');
  });
});
