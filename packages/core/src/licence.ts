/** Licences as Discover and the hub read them. Browser-safe: the hub imports it (`@youiyoux/core/licence`). */
/**
 * A strong copyleft licence (GPL, AGPL): code shipped with it must be released under the same
 * licence. An `OR` choice that offers a permissive licence is not; LGPL and MPL are weak copyleft.
 */
export function copyleft(spdx: string): boolean {
  const strong = (part: string): boolean => part.split(/\s+(?:AND|WITH)\s+/).some((id) => /^A?GPL-/.test(id.replace(/[()]/g, "").trim()));
  return spdx.split(/\s+OR\s+/).every(strong);
}
