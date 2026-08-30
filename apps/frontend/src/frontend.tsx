/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the router to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();
const router = createRouter({ routeTree });
const app = (
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);

import { routeTree } from "./routeTree.gen";

// routeTree.gen.ts is written by `tsr generate` / `tsr watch` from the files
// in src/routes. It is generated, never hand-edited.


// Registers this router's types globally, so <Link to="..."> autocompletes
// every real path and rejects one that does not exist.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const elem = document.getElementById("root")!;

// https://bun.com/docs/bundler/hot-reloading#import-meta-hot-data
(import.meta.hot.data.root ??= createRoot(elem)).render(app);
