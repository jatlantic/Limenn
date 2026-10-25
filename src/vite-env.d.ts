/// <reference types="vite/client" />
declare module 'ort-dist/*?url' {
  const url: string;
  export default url;
}
declare module 'mammoth/mammoth.browser' {
  const mammoth: { extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
  export default mammoth;
}
