/**
 * The one check every SQL-backed store here needs before it names a table.
 *
 * Table names reach `sql.literal`, which does not parameterise, so a name that
 * came from somewhere untrusted is an injection rather than a typo. Anything
 * that is not a plain identifier is *refused* rather than quoted: quoting
 * invites the question of which dialect's quoting, and a store whose table name
 * is attacker-shaped is a bug worth failing on rather than escaping around.
 *
 * Internal, and shared because it had been copied into four stores. Four copies
 * of a security check is three chances for one of them to drift.
 */
export const escapeIdentifier = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name: ${name}`)
  }
  return name
}
