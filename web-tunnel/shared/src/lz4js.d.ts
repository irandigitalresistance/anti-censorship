declare module 'lz4js' {
  export interface Lz4JsModule {
    compress(input: Uint8Array): Uint8Array | number[];
    decompress(input: Uint8Array): Uint8Array | number[];
  }

  const lz4js: Lz4JsModule;
  export default lz4js;
}
