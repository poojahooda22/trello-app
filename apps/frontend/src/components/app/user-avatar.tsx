/**
 * A person, drawn from the only thing we store about them: their email.
 *
 * Initials render immediately and always. If that email has a Gravatar, the
 * picture fades in over the top. Three things can stop that happening — the
 * person has no Gravatar (`d=404` makes it a 404 rather than a generated
 * blob), the request fails, or `crypto.subtle` is missing because the page is
 * not on HTTPS. All three land on the initials, which is why they are the base
 * layer rather than a fallback branch.
 */
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

// Fixed palette so a given person keeps the same colour everywhere in the app.
const COLOURS = [
  "bg-[#0C66E4]",
  "bg-[#5E4DB2]",
  "bg-[#216E4E]",
  "bg-[#A54800]",
  "bg-[#943D73]",
  "bg-[#206A83]",
  "bg-[#AE2E24]",
];

function colourFor(email: string) {
  let sum = 0;
  for (const ch of email) sum += ch.charCodeAt(0);
  return COLOURS[sum % COLOURS.length];
}

function initialsFor(email: string) {
  return email.slice(0, 2).toUpperCase();
}

/** Gravatar keys on the SHA-256 of the trimmed, lowercased address. */
async function gravatarHash(email: string): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function UserAvatar({
  email,
  px = 28,
  className,
  title,
}: {
  email: string;
  /** Rendered size in CSS pixels; also what we ask Gravatar for, at 2x. */
  px?: number;
  className?: string;
  title?: string;
}) {
  const [hash, setHash] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHash(null);
    setFailed(false);
    gravatarHash(email).then((h) => {
      if (!cancelled) setHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return (
    <span
      title={title ?? email}
      style={{ width: px, height: px }}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white",
        colourFor(email),
        className,
      )}
    >
      <span style={{ fontSize: Math.max(9, Math.round(px * 0.36)) }}>{initialsFor(email)}</span>

      {hash && !failed && (
        <img
          // 2x for retina. d=404 is what makes "no Gravatar" detectable at all:
          // the default would otherwise be a generated image we cannot tell
          // apart from a real one.
          src={`https://www.gravatar.com/avatar/${hash}?s=${px * 2}&d=404`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
