/**
 * The root route. Every other route renders inside this one's <Outlet />.
 * Filename is fixed: the generator looks for exactly `__root.tsx`.
 */
import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import "../index.css";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  // No app chrome at the root: auth pages render full-bleed. Page-level
  // navigation belongs to the routes that need it.
  return <Outlet />;
}

function NotFound() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">404</h1>
      <p className="text-muted-foreground">No route matches this URL.</p>
      <Link to="/" className="underline">
        Go home
      </Link>
    </div>
  );
}
