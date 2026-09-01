/** src/routes/index.tsx -> "/" */
import { createFileRoute, redirect } from "@tanstack/react-router";

// The path string is filled in by the generator from this file's location.
// Do not hand-edit it; rename the file instead.
export const Route = createFileRoute("/")({
  // Nothing is rendered at "/": the app begins at the auth pages, and a bare
  // domain has to land somewhere. beforeLoad runs before any render, so the
  // visitor never sees an empty frame first. Someone who already holds a token
  // goes straight to their boards instead of being asked to sign up again.
  beforeLoad: () => {
    if (localStorage.getItem("token")) throw redirect({ to: "/boards" });
    throw redirect({ to: "/signup" });
  },
});
