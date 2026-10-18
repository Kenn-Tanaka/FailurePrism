import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveViewFromLocation,
  getHashForView,
  getTitleForView,
  checkGatewayHealth,
} from '../../src/shell/gatewayBridge';

describe('FailurePrism Shell - gatewayBridge & Routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves active view from URL hash and search query', () => {
    expect(resolveViewFromLocation('')).toBe('menu');
    expect(resolveViewFromLocation('#menu')).toBe('menu');
    expect(resolveViewFromLocation('#/menu')).toBe('menu');
    expect(resolveViewFromLocation('#tpdd')).toBe('tpdd');
    expect(resolveViewFromLocation('#/tpdd')).toBe('tpdd');
    expect(resolveViewFromLocation('#TPDD')).toBe('tpdd');
    expect(resolveViewFromLocation('#vta')).toBe('vta');
    expect(resolveViewFromLocation('#/vta')).toBe('vta');
    expect(resolveViewFromLocation('', '?app=tpdd')).toBe('tpdd');
    expect(resolveViewFromLocation('', '?app=vta')).toBe('vta');
    expect(resolveViewFromLocation('#unknown')).toBe('menu');
  });

  it('returns canonical hashes and browser tab titles for each view', () => {
    expect(getHashForView('menu')).toBe('#menu');
    expect(getHashForView('tpdd')).toBe('#tpdd');
    expect(getHashForView('vta')).toBe('#vta');

    expect(getTitleForView('menu')).toContain('FailurePrism');
    expect(getTitleForView('tpdd')).toContain('TPDD-Editor');
    expect(getTitleForView('vta')).toContain('VTA-Editor');
  });

  it('checks LLM-Gateway v2.0.0 /health endpoint and parses full status', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ok',
        pid: 12345,
        version: '2.0.0',
        embedded: 'ready',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const status = await checkGatewayHealth();
    expect(status.online).toBe(true);
    expect(status.version).toBe('2.0.0');
    expect(status.pid).toBe(12345);
    expect(status.embedded).toBe('ready');
  });

  it('returns offline status when LLM-Gateway is unreachable', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const status = await checkGatewayHealth();
    expect(status.online).toBe(false);
    expect(status.error).toBeDefined();
  });

  describe('reconcileGatewayTokens (Issue 6)', () => {
    it('syncs token from TPDD to VTA on initial entry', async () => {
      const { reconcileGatewayTokens } = await import('../../src/shell/gatewayBridge');
      const res = reconcileGatewayTokens('', 'token-A', '');
      expect(res.nextToken).toBe('token-A');
      expect(res.updateVta).toBe(true);
      expect(res.updateTpdd).toBe(false);
    });

    it('syncs token update from TPDD to VTA', async () => {
      const { reconcileGatewayTokens } = await import('../../src/shell/gatewayBridge');
      const res = reconcileGatewayTokens('token-A', 'token-B', 'token-A');
      expect(res.nextToken).toBe('token-B');
      expect(res.updateVta).toBe(true);
      expect(res.updateTpdd).toBe(false);
    });

    it('syncs token update from VTA to TPDD', async () => {
      const { reconcileGatewayTokens } = await import('../../src/shell/gatewayBridge');
      const res = reconcileGatewayTokens('token-B', 'token-B', 'token-C');
      expect(res.nextToken).toBe('token-C');
      expect(res.updateTpdd).toBe(true);
      expect(res.updateVta).toBe(false);
    });

    it('allows deleting token from TPDD without revival from VTA', async () => {
      const { reconcileGatewayTokens } = await import('../../src/shell/gatewayBridge');
      const res = reconcileGatewayTokens('token-C', '', 'token-C');
      expect(res.nextToken).toBe('');
      expect(res.updateVta).toBe(true);
      expect(res.updateTpdd).toBe(false);
    });

    it('allows deleting token from VTA without revival from TPDD', async () => {
      const { reconcileGatewayTokens } = await import('../../src/shell/gatewayBridge');
      const res = reconcileGatewayTokens('token-C', 'token-C', '');
      expect(res.nextToken).toBe('');
      expect(res.updateTpdd).toBe(true);
      expect(res.updateVta).toBe(false);
    });
  });
});
