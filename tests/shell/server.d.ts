declare module '../../scripts/server.mjs' {
  export function createRequestHandler(options?: {
    distDir?: string;
    host?: string;
    port?: number;
    gatewayPort?: number;
  }): (req: any, res: any) => void;

  export function startServer(options?: {
    dist?: string;
    host?: string;
    port?: number;
    gatewayPort?: number;
  }): Promise<any>;
}
