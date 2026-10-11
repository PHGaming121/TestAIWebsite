/**
 * Media generation: images and video through Puter's AI drivers.
 *
 * `puter.ai.txt2img()` resolves to an HTMLImageElement and `puter.ai.txt2vid()`
 * to an HTMLVideoElement — not Blobs — so the real work here is turning whatever
 * comes back (element, Blob, Response, data URI, remote URL) into bytes we can
 * store in the workspace, show in the chat and download.
 *
 * Both APIs accept a test mode that returns a sample *without spending credits*,
 * which is exposed all the way up to the UI as "Free sample".
 */
import { ensurePuter } from './llm.js';
import { prettyError } from './util.js';

/** Image models worth surfacing first; the live list may add many more. */
export const IMAGE_MODELS = [
  { id: '', label: 'Provider default (gpt-image-2)', note: 'Best general quality' },
  { id: 'gpt-image-2', label: 'GPT Image 2', note: 'OpenAI' },
  { id: 'openai/gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', note: 'OpenAI, xhigh/max quality' },
  { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', note: 'Google, size tiers 512/1K/2K/4K' },
  { id: 'google/gemini-3-pro-image', label: 'Gemini 3 Pro Image', note: 'Google' },
  { id: 'grok-imagine-image-2.0', label: 'Grok Imagine Image 2.0', note: 'xAI, 1k/2k' },
  { id: '@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 Schnell', note: 'Cloudflare, fast + cheap' },
  { id: 'black-forest-labs/flux-2-dev', label: 'FLUX.2 Dev', note: 'Replicate' },
  { id: 'black-forest-labs/flux-schnell', label: 'FLUX Schnell', note: 'Replicate' },
  { id: 'seedream-5-0-lite-260128', label: 'Seedream 5.0 Lite', note: 'BytePlus' },
];

/** Video models: Together AI (Wan) and BytePlus (Seedance) drivers. */
export const VIDEO_MODELS = [
  { id: '', label: 'Default (Wan 2.7 text-to-video)', note: 'Together AI' },
  { id: 'togetherai:wan-ai/wan2.7-t2v', label: 'Wan 2.7 T2V', note: 'Together AI' },
  { id: 'seedance-2-5', label: 'Seedance 2.5', note: 'BytePlus, up to 30 reference images, audio' },
  { id: 'seedance-2-0', label: 'Seedance 2.0', note: 'BytePlus, up to 9 reference images, audio' },
];

export const IMAGE_PROVIDERS = ['openai', 'gemini', 'xai', 'cloudflare', 'replicate', 'together', 'byteplus'];
export const VIDEO_PROVIDERS = ['together-video-generation', 'byteplus-video-generation'];

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
};

/**
 * Duck-typed Blob check. `instanceof Blob` is unreliable across realms — a Blob
 * from an iframe, a Worker or (in tests) jsdom is a different constructor.
 */
export function isBlobLike(x) {
  return !!x && typeof x === 'object' && typeof x.arrayBuffer === 'function' &&
    typeof x.size === 'number' && typeof x.type === 'string';
}

export function extForMime(mime, fallback = 'bin') {
  if (!mime) return fallback;
  return MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || fallback;
}

/** data: URI → Blob without going through fetch (works in every context). */
function dataUriToBlob(uri) {
  const m = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(String(uri));
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (m[2]) {
    const bin = atob(m[3].replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(m[3])], { type: mime });
}

async function blobFromResponse(res) {
  if (!res) throw new Error('Empty response from the media driver');
  if (typeof res.blob === 'function') return await res.blob();
  if (typeof res.arrayBuffer === 'function') return new Blob([await res.arrayBuffer()]);
  if (res.body && typeof res.text === 'function') return new Blob([await res.text()]);
  throw new Error('Unsupported response shape from the media driver');
}

/**
 * Fetch a remote URL as a Blob. Tries the normal network first and falls back to
 * `puter.net.fetch`, which is proxied by Puter and therefore not bound by CORS —
 * the usual reason a generated-media URL fails to download in a browser.
 */
async function urlToBlob(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await blobFromResponse(res);
  } catch { /* fall through to the Puter proxy */ }
  const puter = await ensurePuter().catch(() => null);
  if (puter?.net?.fetch) {
    const res = await puter.net.fetch(url);
    if (!res?.ok) throw new Error(`Could not download the generated media (${res?.status || 'network error'})`);
    return await blobFromResponse(res);
  }
  throw new Error('Could not download the generated media (blocked by CORS and puter.net.fetch is unavailable)');
}

/**
 * Normalise any Puter media result into `{ blob, mime, src }`.
 * Accepts HTMLImageElement / HTMLVideoElement, Blob, Response, data URI, plain
 * URL, or an object carrying one of those under a common key.
 */
export async function toMediaBlob(result) {
  if (result === null || result === undefined || result === '') throw new Error('The model returned no media');

  // A URL or data URI
  if (typeof result === 'string') {
    const blob = await srcToBlob(result);
    return { blob, mime: blob.type || '', src: result };
  }
  if (typeof result !== 'object') throw new Error('Unrecognised media result');

  // Blob / File (duck-typed: works across realms)
  if (isBlobLike(result)) return { blob: result, mime: result.type || '', src: '' };

  // Response (from fetch or puter.net.fetch)
  if (typeof result.blob === 'function' && (typeof result.status === 'number' || typeof result.ok === 'boolean')) {
    const blob = await blobFromResponse(result);
    return { blob, mime: blob.type || '', src: '' };
  }

  // HTMLImageElement / HTMLVideoElement / HTMLAudioElement (what Puter resolves to)
  const src = (typeof result.currentSrc === 'string' && result.currentSrc) ||
              (typeof result.src === 'string' && result.src) || '';
  if (src) {
    const blob = await srcToBlob(src);
    return { blob, mime: blob.type || guessMimeFromSrc(src, result) || '', src };
  }

  // Objects: dig for something usable
  const candidate = result.blob || result.file || result.data || result.image || result.video ||
    result.url || result.href || result.output || result.result || result.content;
  if (candidate && candidate !== result) return await toMediaBlob(candidate);
  if (Array.isArray(result.items) && result.items.length) return await toMediaBlob(result.items[0]);
  if (Array.isArray(result) && result.length) return await toMediaBlob(result[0]);

  throw new Error('Unrecognised media result — expected an image/video element, Blob or URL');
}

/** Best-effort MIME guess from a source URL and the element that carried it. */
function guessMimeFromSrc(src, el) {
  const m = /^data:([^;,]+)/.exec(String(src));
  if (m) return m[1];
  const tag = String(el?.tagName || '').toUpperCase();
  if (tag === 'IMG') return 'image/png';
  if (tag === 'VIDEO') return 'video/mp4';
  if (tag === 'AUDIO') return 'audio/mpeg';
  const ext = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|ogg)(?:[?#]|$)/i.exec(String(src));
  return ext ? MIME_EXT[`image/${ext[1]}`] || MIME_EXT[`video/${ext[1]}`] || '' : '';
}

async function srcToBlob(src) {
  const s = String(src);
  if (s.startsWith('data:')) {
    const blob = dataUriToBlob(s);
    if (!blob) throw new Error('Malformed data URI in the generated media');
    return blob;
  }
  if (s.startsWith('blob:')) {
    const res = await fetch(s);
    return await blobFromResponse(res);
  }
  return await urlToBlob(s);
}

/** Build an object URL for display; callers own it and should revoke it later. */
export function objectUrl(blob) {
  try { return URL.createObjectURL(blob); } catch { return ''; }
}

/**
 * Blob → data URI without FileReader, so it works for Blobs from any realm
 * (iframe, Worker, jsdom). Only used for reference images sent back to the API:
 * display paths use cheap object URLs instead of multi-megabyte base64.
 */
async function dataUrlOf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/**
 * Generate an image.
 * @param {object} o
 * @param {string} o.prompt        required
 * @param {string}[o.model]        image model id
 * @param {string}[o.provider]     openai|gemini|xai|cloudflare|replicate|together|byteplus
 * @param {string}[o.quality]      low|medium|high|auto|xhigh|max, or a Gemini size tier (512|1K|2K|4K)
 * @param {string}[o.aspectRatio]  e.g. "16:9"
 * @param {number}[o.width] @param {number}[o.height]
 * @param {number}[o.steps] @param {number}[o.seed]
 * @param {string}[o.negativePrompt]
 * @param {string}[o.referenceImage] data URI / URL — turns this into image-to-image editing
 * @param {boolean}[o.testMode]    sample output that does not spend credits
 * @returns {Promise<{blob:Blob, mime:string, ext:string, url:string, model:string, testMode:boolean, kind:'image'}>}
 */
export async function generateImage(o = {}) {
  const prompt = String(o.prompt || '').trim();
  if (!prompt) throw new Error('An image prompt is required');
  const puter = await ensurePuter();
  if (typeof puter.ai?.txt2img !== 'function') throw new Error('This build of Puter.js has no txt2img()');

  const options = {};
  if (o.model) options.model = String(o.model);
  if (o.provider) options.provider = String(o.provider);
  if (o.quality) options.quality = String(o.quality);
  if (o.aspectRatio) {
    options.aspect_ratio = String(o.aspectRatio);
    const m = /^(\d+)\s*[:x]\s*(\d+)$/i.exec(String(o.aspectRatio));
    if (m) options.ratio = { w: Number(m[1]), h: Number(m[2]) };
  }
  if (o.width) options.width = Number(o.width);
  if (o.height) options.height = Number(o.height);
  if (o.steps) options.steps = Number(o.steps);
  if (typeof o.seed === 'number' && Number.isFinite(o.seed)) options.seed = o.seed;
  if (o.negativePrompt) options.negative_prompt = String(o.negativePrompt);
  if (o.referenceImage) {
    options.input_image = String(o.referenceImage);
    if (String(o.referenceImage).startsWith('data:')) {
      options.input_image_mime_type = /^data:([^;,]+)/.exec(String(o.referenceImage))?.[1] || 'image/png';
    }
    if (typeof o.strength === 'number') options.strength = o.strength;
  }
  options.prompt = prompt;

  const raw = o.testMode
    ? await puter.ai.txt2img(prompt, { ...options, test_mode: true })
    : await puter.ai.txt2img(prompt, options);

  const { blob, mime, src } = await toMediaBlob(raw);
  const type = mime || blob.type || 'image/png';
  return {
    blob, mime: type, ext: extForMime(type, 'png'), src,
    url: objectUrl(blob),
    model: options.model || 'provider default',
    testMode: !!o.testMode,
    kind: 'image',
  };
}

/**
 * Generate a video clip.
 * @param {object} o
 * @param {string} o.prompt              required
 * @param {string}[o.model]              default "togetherai:wan-ai/wan2.7-t2v"
 * @param {string}[o.provider]           together-video-generation | byteplus-video-generation
 * @param {number}[o.seconds]            clip length (falls back to the model default)
 * @param {string}[o.size]               "1280x720" or a tier such as "720p"
 * @param {string}[o.firstFrame]         data URI / URL → image-to-video
 * @param {string}[o.lastFrame]          data URI / URL
 * @param {string[]}[o.referenceImages]  style/subject references (Seedance)
 * @param {string}[o.negativePrompt]
 * @param {boolean}[o.generateAudio]     soundtrack on models that support it
 * @param {number}[o.fps] @param {number}[o.seed]
 * @param {boolean}[o.testMode]          sample clip that does not spend credits
 */
export async function generateVideo(o = {}) {
  const prompt = String(o.prompt || '').trim();
  if (!prompt) throw new Error('A video prompt is required');
  const puter = await ensurePuter();
  if (typeof puter.ai?.txt2vid !== 'function') {
    throw new Error('This build of Puter.js has no txt2vid() — video generation is unavailable');
  }

  const options = { prompt };
  if (o.model) options.model = String(o.model);
  if (o.provider) options.provider = String(o.provider);
  if (o.seconds) options.seconds = Number(o.seconds);
  if (o.size) options.size = String(o.size);
  if (o.firstFrame) options.input_reference = String(o.firstFrame);
  if (o.lastFrame) options.last_frame = String(o.lastFrame);
  if (Array.isArray(o.referenceImages) && o.referenceImages.length) options.reference_images = o.referenceImages.map(String);
  if (o.negativePrompt) options.negative_prompt = String(o.negativePrompt);
  if (typeof o.generateAudio === 'boolean') options.generate_audio = o.generateAudio;
  if (o.fps) options.fps = Number(o.fps);
  if (typeof o.seed === 'number' && Number.isFinite(o.seed)) options.seed = o.seed;
  if (o.testMode) options.test_mode = true;

  const raw = await puter.ai.txt2vid(options);
  const { blob, mime, src } = await toMediaBlob(raw);
  const type = mime || blob.type || 'video/mp4';
  return {
    blob, mime: type, ext: extForMime(type, 'mp4'), src,
    url: objectUrl(blob),
    model: options.model || 'togetherai:wan-ai/wan2.7-t2v',
    seconds: options.seconds || null,
    testMode: !!o.testMode,
    kind: 'video',
  };
}

/** Read a workspace image into a data URI so it can be used as a reference. */
export async function workspaceFileToDataUrl(ws, path) {
  const raw = await (typeof ws.readBlob === 'function' ? ws.readBlob(path) : ws.read(path));
  if (!raw) throw new Error(`Could not read ${path}`);
  if (typeof raw === 'string') return `data:text/plain;base64,${btoa(unescape(encodeURIComponent(raw)))}`;
  return await dataUrlOf(isBlobLike(raw) ? raw : new Blob([raw]));
}

export { prettyError };
