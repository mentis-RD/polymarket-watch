/**
 * Escape a string so it renders as literal text inside a `parse_mode: Markdown`
 * (legacy MarkdownV1) Telegram message. The legacy parser treats these as
 * formatting metacharacters: `_ * [ ` and the bot will reject the whole
 * message with HTTP 400 "can't parse entities" on an unbalanced occurrence.
 *
 * We deliberately stick with legacy Markdown rather than MarkdownV2 because
 * V2 requires escaping a much larger set (including `.` and `-`) which would
 * pollute every status message.
 *
 * Polymarket market questions regularly include `_` (slug-style emphasis),
 * `*` (asterisk callouts), `` ` `` (price quotes) — leaving them raw causes
 * silent alert drops.
 */
export function escapeMd(s: string | null | undefined): string {
  if (s == null) return "";
  // Order matters: backslash first to avoid double-escaping our own escapes.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/`/g, "\\`");
}
