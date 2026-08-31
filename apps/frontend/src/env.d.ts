// The two public URLs are required, not optional: Bun substitutes them into the
// client bundle at bundle time, and an unset one is left as a literal
// `process.env.…` that throws in the browser. src/index.ts refuses to serve
// unless both are present, which is what makes `string` here honest.
declare namespace NodeJS {
  interface ProcessEnv {
    BUN_PUBLIC_API_URL: string;
    BUN_PUBLIC_WS_URL: string;
  }
}
