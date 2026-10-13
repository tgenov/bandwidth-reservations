/**
 * The dev cell gate for integration tests (engineering standard §6). On a laptop, a test skips with a clear
 * message when the dev cell is not reachable. With `REQUIRE_DEV_CELL=1` (the local `npm run ci`), an
 * unreachable dev cell is a failure, so a run that tested nothing cannot pass.
 */

/** True when the environment requires the dev cell (`REQUIRE_DEV_CELL=1`). */
export function devCellRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['REQUIRE_DEV_CELL'] === '1';
}

/**
 * Gives the `skip` value for a test that needs the dev cell. `unreachable` is undefined when the dev cell
 * answers, else the reason it does not. Returns false when the dev cell answers. Returns the skip message
 * when it does not. Throws when `REQUIRE_DEV_CELL=1` and the dev cell does not answer.
 */
export function devCellSkip(unreachable: string | undefined, env: NodeJS.ProcessEnv = process.env): string | false {
  if (unreachable === undefined) return false;
  const reason = `dev cell not reachable: ${unreachable} (run \`npm run dev:up\`)`;
  if (devCellRequired(env)) throw new Error(`REQUIRE_DEV_CELL=1 and the ${reason}`);
  console.log(`# SKIP integration: ${reason}`);
  return reason;
}
