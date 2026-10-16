import { KANTA_DRAG_TYPE } from '../services/layout.service';
import { SongRef } from '../services/library.service';

export interface DragPreviewOptions {
  songs: { title: string; artist: string; coverUrl: string | null }[];
  count?: number;
}

// Payload is always a JSON array of song refs so queues can insert one or many songs.
export function writeDragPayload(event: DragEvent, songs: SongRef[]): void {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  transfer.setData(
    KANTA_DRAG_TYPE,
    JSON.stringify(songs.map(({ artist, album, title }) => ({ artist, album, title }))),
  );
  transfer.effectAllowed = 'copy';
}

export function readDragPayload(event: DragEvent): SongRef[] {
  const raw = event.dataTransfer?.getData(KANTA_DRAG_TYPE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SongRef | SongRef[];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (song) => song?.artist && song?.album && song?.title,
    );
  } catch {
    return [];
  }
}

// Builds an off-screen card that mimics a karaoke queue row; multiple items render as a stack.
export function setQueueItemDragImage(event: DragEvent, options: DragPreviewOptions): void {
  const transfer = event.dataTransfer;
  if (!transfer || !options.songs.length) return;
  const root = document.createElement('div');
  root.className = 'kanta-drag-stack';
  const visible = options.songs.slice(0, 3);
  [...visible].reverse().forEach((song, reversedIndex) => {
    const depth = visible.length - 1 - reversedIndex;
    const card = document.createElement('div');
    card.className = 'kanta-drag-card';
    card.style.transform = `translate(${depth * 6}px, ${depth * 6}px) scale(${1 - depth * 0.03})`;
    card.style.opacity = String(1 - depth * 0.15);
    card.style.zIndex = String(10 - depth);
    const cover = document.createElement('div');
    cover.className = 'kanta-drag-cover';
    if (song.coverUrl) cover.style.backgroundImage = `url("${song.coverUrl}")`;
    const text = document.createElement('div');
    text.className = 'kanta-drag-text';
    const title = document.createElement('strong');
    title.textContent = song.title;
    const artist = document.createElement('small');
    artist.textContent = song.artist;
    text.append(title, artist);
    card.append(cover, text);
    root.append(card);
  });
  const total = options.count ?? options.songs.length;
  if (total > 1) {
    const badge = document.createElement('span');
    badge.className = 'kanta-drag-badge';
    badge.textContent = String(total);
    root.append(badge);
  }
  document.body.append(root);
  transfer.setDragImage(root, 24, 24);
  setTimeout(() => root.remove(), 0);
}
