/**
 * Generates src/routeTree.gen.ts from the files in src/routes.
 *
 *   bun run generate-routes.ts            one-shot (used by `build`)
 *   bun run generate-routes.ts --watch    regenerate on change (used by `dev`)
 *
 * Why this exists instead of `tsr watch`
 * -------------------------------------
 * @tanstack/router-cli 1.167.32 writes the route tree to a temp file and then
 * RENAMES it over the target. On Windows that rename fails with EPERM whenever
 * the target already exists — which kills `tsr watch` on the first edit, and
 * makes a bare `tsr generate` exit 1 without writing anything. Measured here:
 *
 *   overwrite an existing tree via rename -> EPERM, exit 1, no change
 *   write the same bytes in place         -> works
 *
 * So the CLI generates into a scratch file next to the real one (same
 * directory, so its relative imports are byte-identical — verified), and we
 * copy the contents over the real file in place. No rename, and the real tree
 * is never absent, so the bundler can never rebuild into a missing-file gap.
 */
import { watch } from "node:fs";
import { rm } from "node:fs/promises";

const ROUTES_DIR = "./src/routes";
const SCRATCH = "./src/routeTree.tmp.ts"; // must match generatedRouteTree in tsr.config.json
const ROUTE_TREE = "./src/routeTree.gen.ts";
const DEBOUNCE_MS = 150;
const watchMode = process.argv.includes("--watch");

async function generate(): Promise<boolean> {
  await rm(SCRATCH, { force: true });

  const proc = Bun.spawn(["bunx", "tsr", "generate"], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;

  if (code !== 0) {
    // Never swallow this: a stale route tree breaks every <Link> silently.
    console.error(`[routes] generation FAILED (exit ${code}) — route tree left unchanged`);
    console.error((await new Response(proc.stderr).text()).trim());
    return false;
  }

  const scratch = Bun.file(SCRATCH);
  if (!(await scratch.exists())) {
    console.error(`[routes] generator exited 0 but wrote no ${SCRATCH}`);
    return false;
  }

  // In-place write, not a rename. This is the part Windows allows.
  await Bun.write(ROUTE_TREE, await scratch.text());
  await rm(SCRATCH, { force: true });

  console.log(`[routes] regenerated  ${new Date().toLocaleTimeString()}`);
  return true;
}

if (!watchMode) {
  process.exit((await generate()) ? 0 : 1);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let queued = false;

async function run(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  await generate();
  running = false;
  if (queued) {
    queued = false;
    void run();
  }
}

watch(ROUTES_DIR, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  if (!/\.(tsx?|jsx?)$/.test(filename)) return;
  clearTimeout(timer);
  timer = setTimeout(() => void run(), DEBOUNCE_MS);
});

console.log(`[routes] watching ${ROUTES_DIR}`);
void run(); // generate once at startup so a fresh clone is never stale
