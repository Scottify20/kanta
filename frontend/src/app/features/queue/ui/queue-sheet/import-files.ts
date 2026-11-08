const AUDIO_EXTENSIONS = /\.(?:aac|aif|aiff|alac|flac|m4a|m4b|mp3|mp4|oga|ogg|opus|wav|wave|webm|wma)$/i;

export interface ImportMatch {
  audio: File;
  lyrics?: File;
  ambiguous: boolean;
}

export function matchImportFiles(files: readonly File[], folder: boolean): {
  matches: ImportMatch[];
  unmatchedLyrics: File[];
} {
  const lyricsFiles = files.filter((file) => /\.ttml$/i.test(file.name));
  const audioFiles = files.filter((file) =>
    !/\.ttml$/i.test(file.name) && (!folder || AUDIO_EXTENSIONS.test(file.name) || file.type.startsWith('audio/')),
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
    const ambiguous = lyrics.length > 1 || (lyrics.length > 0 && (audioCounts.get(name) ?? 0) > 1);
    return { audio, lyrics: ambiguous ? undefined : lyrics[0], ambiguous };
  });
  return { matches, unmatchedLyrics: lyricsFiles.filter((file) => !usedLyrics.has(file)) };
}
