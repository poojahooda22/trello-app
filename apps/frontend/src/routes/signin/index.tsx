import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { signin } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { TrelloMark } from "@/components/app/trello-mark";
import signupLeft from "@/assets/signup-left.jpg";
import signupRight from "@/assets/signup-right.jpg";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The path string is filled in by the generator from this file's location.
// Do not hand-edit it; rename the file instead.
export const Route = createFileRoute("/signin/")({
  component: Signin,
});

function Signin() {
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: signin,
    onSuccess: ({ token }) => {
      localStorage.setItem("token", token);
      navigate({ to: "/boards" });
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    mutation.mutate({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#FAFBFC] px-4 py-12">
      {/* Decorative corners; multiply-blend melts the baked light backgrounds into the page. */}
      <img
        src={signupLeft}
        alt=""
        className="pointer-events-none absolute bottom-0 left-0 hidden w-80 select-none mix-blend-multiply xl:block"
      />
      <img
        src={signupRight}
        alt=""
        className="pointer-events-none absolute right-0 bottom-0 hidden w-80 select-none mix-blend-multiply xl:block"
      />

      <Card className="z-10 w-full max-w-100 rounded-lg border-0 py-10 shadow-[0_2px_10px_rgba(9,30,66,0.08)]">
        <CardContent className="flex flex-col gap-6 px-10">
          <div className="flex items-center justify-center gap-2">
            <TrelloMark />
            <span className="text-[26px] font-bold tracking-tight text-[#172B4D]">Trello</span>
          </div>

          <h1 className="text-center text-base font-semibold text-[#172B4D]">Welcome Back</h1>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email" className="text-xs font-semibold text-[#44546F]">
                Email <span className="text-destructive">*</span>
              </Label>
              <Input id="email" name="email" type="email" required placeholder="Enter your email" className="h-10" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password" className="text-xs font-semibold text-[#44546F]">
                Password <span className="text-destructive">*</span>
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                placeholder="Enter your password"
                className="h-10"
              />
            </div>

            <Button
              type="submit"
              disabled={mutation.isPending}
              className="h-10 w-full bg-[#0C66E4] font-semibold text-white hover:bg-[#0055CC]"
            >
              {mutation.isPending ? "Signing up…" : "Log in"}
            </Button>

            {mutation.isError && (
              <p className="text-center text-sm text-destructive">{mutation.error.message}</p>
            )}
          </form>

          <div className="border-t pt-5">
            <p className="text-center text-xs text-muted-foreground">
              Create an account | 
              <a className="pl-1" href="/signup">Sign up</a>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


