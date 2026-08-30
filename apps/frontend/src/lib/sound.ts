/**
 * src/lib/sound.ts — UI sounds.
 *
 * The drop sound is a real recording: "Page turn single" from Mixkit
 * (https://mixkit.co/free-sound-effects/page/), used under the Mixkit Sound
 * Effects Free License. The original stereo download was mixed to mono and
 * silence-trimmed; the file lives in src/assets. Bun's bundler turns the .wav
 * import into a served asset URL (see src/assets.d.ts for its type).
 */
import pageTurnUrl from "@/assets/page-turn.wav";

/** Overall loudness, 0–1. The recording peaks at -1 dBFS, so 0.4 is "subtle". */
const MASTER_VOLUME = 0.4;

// One context for the page, created on first use. Browsers only let a context
// start inside a user gesture; a drop (pointerup) is one, so first use is safe.
let ctx: AudioContext | null = null;
let pageTurn: AudioBuffer | null = null;

// Fetch the bytes as soon as this module loads so the first drop does not wait
// on the network. Decoding needs an AudioContext, which cannot start outside a
// gesture, so that half happens on the first drop instead.
const pageTurnBytes = fetch(pageTurnUrl).then((res) => {
  if (!res.ok) throw new Error(`page-turn.wav: HTTP ${res.status} from ${pageTurnUrl}`);
  return res.arrayBuffer();
});
// A failed prefetch is reported when the sound is played, not as an unhandled
// rejection at page load. This branch only prevents that duplicate report.
pageTurnBytes.catch(() => {});

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

async function pageTurnBuffer(ac: AudioContext): Promise<AudioBuffer> {
  // Decoded once; if decoding throws, `pageTurn` stays null and the next play retries.
  if (!pageTurn) pageTurn = await ac.decodeAudioData((await pageTurnBytes).slice(0));
  return pageTurn;
}

/**
 * Play the page-turn. Call it from inside the drop gesture; it is safe to call
 * without awaiting. After the first play the recording is decoded and cached,
 * so later plays start instantly.
 */
export async function playDropSound(): Promise<void> {
  const ac = context();
  const buffer = await pageTurnBuffer(ac);

  const source = ac.createBufferSource();
  source.buffer = buffer;
  const gain = ac.createGain();
  gain.gain.value = MASTER_VOLUME;
  source.connect(gain).connect(ac.destination);
  source.start();
}
