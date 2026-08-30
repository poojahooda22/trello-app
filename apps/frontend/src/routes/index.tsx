/** src/routes/index.tsx -> "/" */
import { Link, createFileRoute } from "@tanstack/react-router";


// The path string is filled in by the generator from this file's location.
// Do not hand-edit it; rename the file instead.
export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="p-8">
      
    </div>
  );
}
