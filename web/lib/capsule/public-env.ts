/**
 * The handful of configuration values the browser is allowed to know.
 *
 * Only the default parent name so far. It is public by definition — it is
 * printed on every capsule in the demo fleet — but it is still configuration,
 * and having the launch form spell "capsulefleet.eth" as a literal is how a
 * rename ships a page that opens on a name nobody owns.
 *
 * It is duplicated rather than imported because `lib/capsule/env.ts` refuses to
 * load in a browser, and that refusal is worth more than the duplication. The
 * duplication is guarded the same way the record keys are: `loadServerEnv()`
 * asserts the two agree, so a mismatch fails on the server rather than
 * rendering a wrong name to a user.
 */

/**
 * The name the launch form opens on, and the one `/fleet` shows when no other
 * parent is asked for.
 *
 * A DEFAULT, not a limit — this is the one thing to keep in mind when reading
 * the components. `CapsuleMinter` mints under any name whose owner has
 * connected it at /connect, so every screen that shows a parent takes it as
 * state and falls back to this, and nothing derives a capsule's full name from
 * this constant. `PARENT_NAME` was renamed to say so: the old name read like an
 * answer, and it is only ever a starting point.
 *
 * Inlined by Next at build time — `process.env.NEXT_PUBLIC_*` is substituted
 * textually, so this cannot be read from a variable or destructured.
 */
export const DEFAULT_PARENT_NAME = process.env.NEXT_PUBLIC_CAPSULE_PARENT_NAME ?? "";

/** True when the deployment forgot the variable. The UI says so rather than
 *  rendering "undefined.eth" or quietly inventing a parent. */
export const DEFAULT_PARENT_MISSING = DEFAULT_PARENT_NAME === "";

/** What to render when the name is missing: obviously wrong, never plausible. */
export const DEFAULT_PARENT_DISPLAY = DEFAULT_PARENT_MISSING
  ? "«NEXT_PUBLIC_CAPSULE_PARENT_NAME unset»"
  : DEFAULT_PARENT_NAME;
