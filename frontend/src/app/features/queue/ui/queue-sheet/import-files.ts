const AUDIO_EXTENSIONS = /\.(?:aac|aif|aiff|alac|flac|m4a|m4b|mp3|mp4|oga|ogg|opus|wav|wave|webm|wma)$/i;

type MediaStreams = { hasAudio?: boolean; hasVideo?: boolean };

const LYRICS_EXTENSIONS = /\.(?:ttml|lrc)$/i;

async function inspectAudio(file: File): Promise<MediaStreams> {
  const { parseBlob } = await import('music-metadata');
  const { format } = await parseBlob(file, { skipCovers: true });
  return format;
}

export async function filterImportFiles(files: readonly File[], inspect = inspectAudio): Promise<{
  files: File[];
  skipped: File[];
  errors: { file: File; message: string }[];
}> {
  const results: ({ kind: 'accepted' | 'skipped' } | { kind: 'error'; message: string })[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      if (LYRICS_EXTENSIONS.test(file.name)) {
        results[index] = { kind: 'accepted' };
        continue;
      }
      if (!AUDIO_EXTENSIONS.test(file.name) && !file.type.startsWith('audio/')) {
        results[index] = { kind: 'skipped' };
        continue;
      }
      try {
        const format = await inspect(file);
        if (format.hasVideo) results[index] = { kind: 'skipped' };
        else if (format.hasAudio) results[index] = { kind: 'accepted' };
        else results[index] = { kind: 'error', message: 'No audio or video stream found.' };
      } catch (error) {
        results[index] = {
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not inspect audio streams.',
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(files.length, 3) }, () => worker()));
  return {
    files: files.filter((_, index) => results[index].kind === 'accepted'),
    skipped: files.filter((_, index) => results[index].kind === 'skipped'),
    errors: files.flatMap((file, index) => {
      const result = results[index];
      return result.kind === 'error' ? [{ file, message: result.message }] : [];
    }),
  };
}

export interface ImportMatch {
  audio: File;
  lyrics?: File;
  ambiguous: boolean;
}

export function matchImportFiles(files: readonly File[]): {
  matches: ImportMatch[];
  unmatchedLyrics: File[];
} {
  const lyricsFiles = files.filter((file) => LYRICS_EXTENSIONS.test(file.name));
  const audioFiles = files.filter((file) =>
    !LYRICS_EXTENSIONS.test(file.name) && (AUDIO_EXTENSIONS.test(file.name) || file.type.startsWith('audio/')),
  );
  const key = (file: File): string => {
    const directory = (file.webkitRelativePath || '').split('/').slice(0, -1).join('/');
    const stem = file.name.replace(/\.[^/.]+$/, '').toLocaleLowerCase();
    return `${directory}\0${stem}`;
  };
  const lyricsByKey = new Map<string, File[]>();
  const audioCounts = new Map<string, number>();
  for (const lyrics of lyricsFiles) {
    const name = key(lyrics);
    lyricsByKey.set(name, [...(lyricsByKey.get(name) ?? []), lyrics]);
  }
  for (const audio of audioFiles) {
    const name = key(audio);
    audioCounts.set(name, (audioCounts.get(name) ?? 0) + 1);
  }
  const usedLyrics = new Set<File>();
  const matches = audioFiles.map((audio): ImportMatch => {
    const name = key(audio);
    const lyrics = lyricsByKey.get(name) ?? [];
    lyrics.forEach((file) => usedLyrics.add(file));
    const ttml = lyrics.filter((file) => /\.ttml$/i.test(file.name));
    const preferred = ttml.length ? ttml : lyrics;
    const ambiguous = preferred.length > 1 || (preferred.length > 0 && (audioCounts.get(name) ?? 0) > 1);
    return { audio, lyrics: ambiguous ? undefined : preferred[0], ambiguous };
  });
  return { matches, unmatchedLyrics: lyricsFiles.filter((file) => !usedLyrics.has(file)) };
}
