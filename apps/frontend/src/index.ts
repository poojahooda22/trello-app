import { serve } from "bun";
import index from "./index.html";

const server = serve({
  port: 5173,
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
