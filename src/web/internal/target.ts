/**
 * The one target guard behind every outbound web capability.
 *
 * Moved out of the fetch provider when the rendered-page capture arrived:
 * two providers with two copies of an SSRF guard is how one of them falls
 * behind. Pure -- a URL in, a refusal or nothing out -- so each provider
 * names the refusal in its own error vocabulary.
 */

export interface Refusal {
  readonly kind: "invalid" | "denied"
  readonly reason: string
}

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.aws.internal",
  "metadata.azure.internal"
])

const normalizedHostname = (url: URL): string =>
  url.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.+$/, "")


const ipv4Octets = (host: string): ReadonlyArray<number> | undefined => {
  const parts = host.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map(Number)
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : undefined
}

const deniedIpv4 = (octets: ReadonlyArray<number>): boolean => {
  const first = octets[0] ?? 0
  const second = octets[1] ?? 0
  const third = octets[2] ?? 0
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    // 192.0.0.0/24 is IETF protocol assignments, not a routable destination --
    // and 192.0.0.192 is Oracle Cloud's instance-metadata address, so leaving
    // the block out was a metadata endpoint reachable through the guard.
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
}

const ipv6Hextets = (host: string): ReadonlyArray<number> | undefined => {
  if (!host.includes(":")) return undefined
  if (host.includes("%")) return undefined
  const halves = host.split("::")
  if (halves.length > 2) return undefined

  const parseSide = (side: string): ReadonlyArray<number> | undefined => {
    if (side === "") return []
    const pieces = side.split(":")
    const values: Array<number> = []
    for (const piece of pieces) {
      const ipv4 = ipv4Octets(piece)
      if (ipv4 !== undefined) {
        values.push(
          ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0),
          ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0)
        )
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined
      values.push(Number.parseInt(piece, 16))
    }
    return values
  }

  const left = parseSide(halves[0] ?? "")
  const right = parseSide(halves[1] ?? "")
  if (left === undefined || right === undefined) return undefined
  if (halves.length === 1) return left.length === 8 ? left : undefined
  const zeros = 8 - left.length - right.length
  return zeros >= 1 ? [...left, ...Array<number>(zeros).fill(0), ...right] : undefined
}

/** The IPv4 address a pair of hextets encodes, for the embedding prefixes. */
const embeddedIpv4 = (high: number, low: number): ReadonlyArray<number> =>
  [high >> 8, high & 0xff, low >> 8, low & 0xff]

/**
 * Whether an IPv6 target is anything but a public destination.
 *
 * **An allow-list of `2000::/3`, not a list of the bad prefixes.** Naming the
 * blocks -- `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8` and the `::ffff:0:0/96`
 * mapped form -- looked complete and was not, because the interesting attack
 * is not "spell loopback in IPv6" but "spell an IPv4 address in an IPv6
 * prefix nobody enumerated". Three got through a hostile table:
 *
 * - `64:ff9b::7f00:1`, the RFC 6052 NAT64 well-known prefix. On any network
 *   with NAT64 -- the ordinary arrangement on IPv6-only cloud and mobile
 *   networks -- that address *is* 127.0.0.1.
 * - `2002:7f00:1::`, 6to4, which carries its IPv4 in the second and third
 *   hextets.
 * - `::ffff:0:7f00:1`, the RFC 2765 IPv4-*translated* form, one hextet away
 *   from the mapped form that was checked and matching none of its tests.
 *
 * Global unicast is `2000::/3` and everything else is reserved, so the
 * allow-list is both shorter and closed: a prefix nobody thought of is denied
 * by default rather than allowed by default. The two embedding prefixes that
 * live *inside* `2000::/3` still need their own answer, below.
 */
const deniedIpv6 = (hextets: ReadonlyArray<number>): boolean => {
  if (hextets.length !== 8) return true
  const first = hextets[0] ?? 0
  // Everything outside 2000::/3: ::/8 (unspecified, loopback, both IPv4
  // embeddings and the NAT64 prefix), fc00::/7, fe80::/10, fec0::/10, ff00::/8.
  if ((first & 0xe000) !== 0x2000) return true
  // 6to4 relays to the IPv4 address in the next two hextets, so it inherits
  // that address's verdict rather than being denied outright.
  if (first === 0x2002) {
    return deniedIpv4(embeddedIpv4(hextets[1] ?? 0, hextets[2] ?? 0))
  }
  // Teredo (2001::/32) tunnels to an IPv4 endpoint it obfuscates; there is no
  // public destination it is the right way to reach.
  if (first === 0x2001 && (hextets[1] ?? 0) === 0) return true
  return false
}

/**
 * Why a target may not be fetched, or `undefined` when it may.
 *
 * `invalid` is about the URL itself (scheme, credentials); `denied` is about
 * where it points (loopback, private ranges, link-local, metadata hosts,
 * the IPv4-in-IPv6 embeddings). One answer for every provider that reaches
 * out on a model's behalf: the guarded fetch and the rendered-page capture
 * refuse the same targets for the same reasons.
 */
export const refusal = (url: URL): Refusal | undefined => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "invalid", reason: "only http and https are supported" }
  }
  if (url.username !== "" || url.password !== "") {
    return { kind: "invalid", reason: "embedded credentials are not allowed" }
  }

  const host = normalizedHostname(url)
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    // ICANN reserved `.internal` for private-use names in 2024, and three of
    // the four metadata hosts named above already live under it -- so the
    // suffix is the rule and the list was three instances of it. Without this,
    // `metadata.<anything-else>.internal` was a public name as far as the
    // guard was concerned.
    host === "internal" ||
    host.endsWith(".internal") ||
    METADATA_HOSTS.has(host)
  ) {
    return { kind: "denied", reason: "local and metadata hostnames are not allowed" }
  }

  const ipv4 = ipv4Octets(host)
  if (ipv4 !== undefined && deniedIpv4(ipv4)) {
    return { kind: "denied", reason: "non-public IPv4 targets are not allowed" }
  }
  const ipv6 = ipv6Hextets(host)
  if (ipv6 !== undefined && deniedIpv6(ipv6)) {
    return { kind: "denied", reason: "non-public IPv6 targets are not allowed" }
  }
  return undefined
}
