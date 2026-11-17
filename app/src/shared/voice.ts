// Voice input for SOMA AI: speech to text on this computer (main/voice.ts, renderer/voice.ts).
// The engine (sherpa-onnx) comes with the app, the speech model is downloaded on the first use. Nothing spoken leaves
// the computer.

/** The speech model. NVIDIA's Parakeet TDT 0.6B v3 as converted by sherpa-onnx (int8), 25 European languages. */
export const VOICE_MODEL = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  name: 'Parakeet TDT 0.6B v3',
  by: 'NVIDIA',
  license: 'CC BY 4.0',
  /** Size of the download (the archive as of 2026-11-07) and on disk, for the setup dialog. */
  downloadBytes: 487_211_443,
  diskBytes: 670_000_000,
  /** Memory while the model is loaded (measured on Windows: about 900 MB). */
  memory: 'about 1 GB',
};

/**
 * Languages the model understands. It recognizes the language on its own: the choice in the setup only tells whether this
 * model fits, and is kept for other models later. `id`: ISO 639-1.
 */
export const VOICE_LANGUAGES: { id: string; label: string }[] = [
  ['bg', 'Bulgarian'], ['hr', 'Croatian'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'],
  ['et', 'Estonian'], ['fi', 'Finnish'], ['fr', 'French'], ['de', 'German'], ['el', 'Greek'], ['hu', 'Hungarian'],
  ['it', 'Italian'], ['lv', 'Latvian'], ['lt', 'Lithuanian'], ['mt', 'Maltese'], ['pl', 'Polish'], ['pt', 'Portuguese'],
  ['ro', 'Romanian'], ['ru', 'Russian'], ['sk', 'Slovak'], ['sl', 'Slovenian'], ['es', 'Spanish'], ['sv', 'Swedish'],
  ['uk', 'Ukrainian'],
].map(([id, label]) => ({ id, label }));

export const isVoiceLanguage = (v: unknown): v is string => typeof v === 'string' && VOICE_LANGUAGES.some((l) => l.id === v);

/** Longest recording in seconds. The model handles longer ones, but a message to SOMA AI is rarely longer. */
export const VOICE_MAX_SECONDS = 180;
