import { describe, it, expect, vi } from 'vitest';
import { createRequestHandler } from '../../scripts/server.mjs';
import path from 'node:path';
import fs from 'node:fs';

describe('scripts/server.mjs - Error handling & Resiliency (Issue 7)', () => {
  const handler = createRequestHandler({
    distDir: path.resolve(process.cwd(), 'dist'),
    host: '127.0.0.1',
    port: 3000,
    gatewayPort: 8765,
  });

  function createMockRes() {
    let statusCode = 200;
    const headers: Record<string, any> = {};
    let body = '';
    return {
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      writeHead: (code: number, h?: any) => {
        statusCode = code;
        if (h) Object.assign(headers, h);
      },
      end: (chunk?: any) => {
        if (chunk) body += chunk.toString();
      },
      getStatusCode: () => statusCode,
      getHeaders: () => headers,
      getBody: () => body,
    };
  }

  it('safely catches malformed URL (e.g. http://[) and responds with 400 Bad Request without crashing process', () => {
    const req: any = {
      url: 'http://[',
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
  });

  it('safely catches malformed percent encoding and responds with 400 Bad Request without crashing', () => {
    const req: any = {
      url: '/test%E0%A4%A',
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

  it('continues to serve normal valid requests cleanly after an invalid request', async () => {
    const req: any = {
      url: '/',
      method: 'GET',
      headers: {},
      pipe: vi.fn(),
      on: vi.fn(),
    };
    const res = createMockRes();

    await new Promise<void>((resolve) => {
      const origEnd = res.end;
      res.end = (chunk?: any) => {
        origEnd(chunk);
        resolve();
      };
      handler(req, res as any);
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().toLowerCase()).toContain('<!doctype html>');
  });
});
