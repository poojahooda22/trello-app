/** Label colors and priority marks, in one place so cards, lists and the detail page agree. */
import type { Priority } from "@/lib/api";

export const LABEL_CLASS: Record<string, string> = {
  grey: "bg-surface-subtle text-text-subtle",
  blue: "bg-[#E9F2FF] text-[#0055CC]",
  green: "bg-[#DFFCF0] text-[#216E4E]",
  yellow: "bg-[#FFF7D6] text-[#7F5F01]",
  orange: "bg-[#FFF3EB] text-[#A54800]",
  red: "bg-[#FFECEB] text-[#AE2E24]",
  purple: "bg-[#F3F0FF] text-[#5E4DB2]",
};

export const labelClass = (color: string) => LABEL_CLASS[color] ?? LABEL_CLASS.grey!;

/** Priority reads at a glance: an arrow for urgency, a bar for the middle. */
export const PRIORITY_MARK: Record<Priority, { glyph: string; className: string; label: string }> = {
  URGENT: { glyph: "⌃⌃", className: "text-[#AE2E24]", label: "Urgent" },
  HIGH: { glyph: "⌃", className: "text-[#A54800]", label: "High" },
  MEDIUM: { glyph: "=", className: "text-[#7F5F01]", label: "Medium" },
  LOW: { glyph: "⌄", className: "text-[#0055CC]", label: "Low" },
};

/** Deterministic avatar tint, so a person keeps the same color everywhere. */
const AVATAR_TINTS = ["bg-[#0055CC]", "bg-[#5E4DB2]", "bg-[#216E4E]", "bg-[#A54800]", "bg-[#943D73]", "bg-[#206A83]"];

export function avatarTint(id: string): string {
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return AVATAR_TINTS[sum % AVATAR_TINTS.length]!;
}

export const initials = (email: string) => email.slice(0, 2).toUpperCase();
