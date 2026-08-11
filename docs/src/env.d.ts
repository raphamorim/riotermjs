// Ambient types oj provides at build time (previously from vite/client):
// `import.meta.env` and the `?url` asset-import suffix.
interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*?url" {
  const src: string;
  export default src;
}
