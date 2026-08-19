/**
 * Transcription segment as returned by Whisper verbose_json.
 * Only expose the fields the client actually needs.
 */
export type TranscriptSegment = {
  start: number;       // seconds
  end: number;         // seconds
  text: string;
};

export type TranscribeResponse = {
  language: string;
  duration: number;
  segments: TranscriptSegment[];
  full_text: string;
};

export type ApiError = {
  error: string;
  code?: string;
};

export type Highlight = {
  start: number;      // seconds
  end: number;        // seconds
  reason: string;
};

export type HighlightResponse = {
  highlight: Highlight;
  title: string;
  hashtags: string[];
};
