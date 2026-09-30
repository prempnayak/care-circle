/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_AUTH_ISSUER?: string;
  readonly VITE_DASHBOARD_CLIENT_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
