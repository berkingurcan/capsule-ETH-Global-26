/**
 * The handful of configuration values the browser is allowed to know.
 *
 * Only the parent name so far. It is public by definition — it is printed on
 * every capsule in the fleet — but it is still configuration, and having the
 * launch form spell "capsulefleet.eth" as a literal is how a rename ships a
 * page that offers subnames under a name nobody owns.
 *
 * It is duplicated rather than imported because `lib/capsule/env.ts` refuses to
 * load in a browser, and that refusal is worth more than the duplication. The
 * duplication is guarded the same way the record keys are: `loadServerEnv()`
 * asserts the two agree, so a mismatch fails on the server rather than
 * rendering a wrong name to a user.
 */

/**
 * Inlined by Next at build time — `process.env.NEXT_PUBLIC_*` is substituted
 * textually, so this cannot be read from a variable or destructured.
 */
export const PARENT_NAME = process.env.NEXT_PUBLIC_CAPSULE_PARENT_NAME ?? "";

/** True when the deployment forgot the variable. The UI says so rather than
 *  rendering "undefined.eth" or quietly inventing a parent. */
export const PARENT_NAME_MISSING = PARENT_NAME === "";

/** What to render when the name is missing: obviously wrong, never plausible. */
export const PARENT_NAME_DISPLAY = PARENT_NAME_MISSING ? "«NEXT_PUBLIC_CAPSULE_PARENT_NAME unset»" : PARENT_NAME;
