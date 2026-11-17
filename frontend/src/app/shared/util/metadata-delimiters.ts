export const DEFAULT_ARTIST_DELIMITER_LIST = ['&', ',', ';', '/', '+', 'feat.', 'ft.'];
export const DEFAULT_GENRE_DELIMITER_LIST = [',', ';', '/', '|'];
export const DEFAULT_ARTIST_DELIMITERS = DEFAULT_ARTIST_DELIMITER_LIST.join('\n');
export const DEFAULT_GENRE_DELIMITERS = DEFAULT_GENRE_DELIMITER_LIST.join('\n');

export const metadataValueKey = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase();

export function splitMetadataValues(
  value: string | null | undefined,
  delimiters: string | readonly string[],
): string[] {
  const text = value?.trim() ?? '';
  if (!text) return [];

  const tokens = typeof delimiters !== 'string'
    ? delimiters.map((token) => token.trim()).filter(Boolean)
    : delimiters.includes('\n')
      ? delimiters.split(/\r?\n/).map((token) => token.trim()).filter(Boolean)
      : [...delimiters];
  const pattern = [...new Set(tokens)]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const values = pattern ? text.split(new RegExp(`(?:${pattern})`, 'giu')) : [text];
  const seen = new Set<string>();
  return values.flatMap((part) => {
    const label = part.trim();
    const key = metadataValueKey(label);
    if (!label || seen.has(key)) return [];
    seen.add(key);
    return [label];
  });
}
