/// <reference types="vite/client" />
/// <reference types="@react-router/node" />
/// <reference types="wrangler" />

declare module "virtual:react-router/server-build" {
  const build: unknown;
  export default build;
}
