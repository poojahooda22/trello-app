import { serve } from "bun";
import index from "./index.html";

// Bun replaces `process.env.BUN_PUBLIC_*` in the client bundle with the value
// it has at bundle time. When one is missing there is nothing to substitute,
// so the reference ships to the browser and fails there as
// "process is not defined" — far from the cause. Fail here instead.
const missing = ["BUN_PUBLIC_API_URL", "BUN_PUBLIC_WS_URL"].filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `${missing.join(" and ")} not set. In development copy apps/frontend/.env.example to .env; ` +
      "in a container pass them in the environment.",
  );
}

const server = serve({
  // Configurable so the container can be told which port to listen on.
  port: Number(process.env.PORT ?? 5173),
  routes: {
    // Serve index.html for every path. The client router reads the URL and
    // decides what to render, so a deep link like /boards/:id must still get
    // the app shell rather than a 404.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Frontend running at ${server.url}`);
