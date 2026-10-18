declare module 'mammoth' {
  export interface RawTextResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<RawTextResult>;
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: any[] }>;
}

declare module 'pdfjs-dist/build/pdf.worker.mjs?url' {
  const src: string;
  export default src;
}
