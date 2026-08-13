declare module "cloudflare:workers" {
  export const env: {
    DB?: any;
  };
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type D1Database = any;
