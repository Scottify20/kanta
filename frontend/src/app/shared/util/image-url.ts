export function sizedImageUrl(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
if (!url.includes('/media/') && !url.includes('/media-roots/') && !url.includes('/api/artists/photo/')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}w=${width}`;
}