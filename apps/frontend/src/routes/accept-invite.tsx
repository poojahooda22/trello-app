/** src/routes/accept-invite.tsx -> "/accept-invite"
 *
 * Where the emailed invitation link lands. This page did not exist at first:
 * the backend was already minting APP_URL/accept-invite?token=… while the
 * router 404'd on it, so the link appeared to just open your own account.
 *
 * Signed out, the token is parked in localStorage and the visitor sent to sign
 * in or sign up; both return here afterwards and the accept happens in exactly
 * one place. Signed in, it redeems immediately. The invite is bound server-side
 * to the invited address, so redeeming under the wrong account 403s — that case
 * gets a "switch account" path that keeps the token parked.
 */
import { useMutation } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useLightOnly } from "@/components/theme-provider";
import { Card, CardContent } from "@/components/ui/card";
import { TrelloMark } from "@/components/app/trello-mark";
import { acceptInvite } from "@/lib/api";

export const PENDING_INVITE_KEY = "pendingInvite";

export const Route = createFileRoute("/accept-invite")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" && search.token.length > 0 ? search.token : undefined,
  }),
  component: AcceptInvite,
});

function AcceptInvite() {
  useLightOnly();
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  // State, not a plain read: switching accounts signs out on this very page,
  // and the page must re-render into its signed-out shape when that happens.
  const [signedIn, setSignedIn] = useState(() => Boolean(localStorage.getItem("token")));

  const accept = useMutation({
    mutationFn: acceptInvite,
    onSuccess: () => {
      localStorage.removeItem(PENDING_INVITE_KEY);
      navigate({ to: "/boards" });
    },
  });

  // Redeem once on arrival when signed in. The ref, not mutation state, guards
  // the effect against StrictMode's double-invoke firing two accepts.
  const fired = useRef(false);
  useEffect(() => {
    if (!token || !signedIn || fired.current) return;
    fired.current = true;
    accept.mutate(token);
  }, [token, signedIn, accept]);

  useEffect(() => {
    if (token && !signedIn) localStorage.setItem(PENDING_INVITE_KEY, token);
  }, [token, signedIn]);

  function switchAccount() {
    // Park the token first: the effect above parks it only for a visitor who
    // arrived signed out, and this visitor arrived signed in as the wrong
    // person. Without this line, signing in as the right person lands on the
    // boards with the invitation dropped. Then sign out and stay here: the
    // invited person may have no account yet, so they get the same choice a
    // signed-out visitor gets — create one, or sign in — and either way this
    // page is where the accept happens afterwards.
    if (token) localStorage.setItem(PENDING_INVITE_KEY, token);
    localStorage.removeItem("token");
    setSignedIn(false);
  }

  return (
    <div className="bg-surface-sunken flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-100 rounded-lg border-0 py-10 shadow-[0_2px_10px_rgba(9,30,66,0.08)]">
        <CardContent className="flex flex-col items-center gap-5 px-10 text-center">
          <div className="flex items-center gap-2">
            <TrelloMark />
            <span className="text-text-strong text-[26px] font-bold tracking-tight">Trello</span>
          </div>

          {!token && (
            <>
              <p className="text-text-subtle text-sm">
                This invitation link is missing its token. Ask for the invitation to be sent again.
              </p>
              <Link to="/boards" className="text-brand text-sm underline">
                Go to your boards
              </Link>
            </>
          )}

          {token && !signedIn && (
            <>
              <h1 className="text-text-strong text-base font-semibold">You've been invited to a workspace</h1>
              <p className="text-text-subtlest text-sm">
                Sign in — or create an account with the email address the invitation was sent to — and it will be
                accepted automatically.
              </p>
              <div className="flex w-full flex-col gap-2">
                <Button onClick={() => navigate({ to: "/signup" })} className="h-10 w-full">
                  Create an account
                </Button>
                <Button variant="outline" onClick={() => navigate({ to: "/signin" })} className="h-10 w-full">
                  I already have one
                </Button>
              </div>
            </>
          )}

          {token && signedIn && accept.isPending && <p className="text-text-subtle text-sm">Accepting the invitation…</p>}

          {token && signedIn && accept.isError && (
            <>
              <p className="text-destructive text-sm">{accept.error.message}</p>
              {accept.error.message.includes("different email") && (
                <Button variant="outline" onClick={switchAccount} className="h-10 w-full">
                  Use the invited address instead
                </Button>
              )}
              {/* Always a way out. Leaving drops the parked invitation, so it
                  cannot capture the next sign-in; the link in the mail still
                  works whenever the right person opens it. */}
              <Link
                to="/boards"
                onClick={() => localStorage.removeItem(PENDING_INVITE_KEY)}
                className="text-brand text-sm underline"
              >
                Go to your boards
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
