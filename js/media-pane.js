/**
 * Create pane: manual image and video generation through Puter's media drivers.
 *
 * Everything the agent can do with generate_image / generate_video is available
 * here by hand, including the credit-free "test mode" sample, image-to-image
 * references and image-to-video first frames picked straight from the workspace.
 */
import { el, prettyError, downloadBlob, basename, formatBytes } from './util.js';
import { icon, toast } from './ui.js';
import {
  generateImage, generateVideo, IMAGE_MODELS, VIDEO_MODELS, IMAGE_PROVIDERS, VIDEO_PROVIDERS, workspaceFileToDataUrl,
} from './media.js';

const IMAGE_RATIOS = ['', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '21:9'];
const IMAGE_QUALITY = [
  { v: '', label: 'default' }, { v: 'low', label: 'low' }, { v: 'medium', label: 'medium' },
  { v: 'high', label: 'high' }, { v: 'auto', label: 'auto' }, { v: 'xhigh', label: 'xhigh' },
  { v: '512', label: '512 (Gemini)' }, { v: '1K', label: '1K (Gemini)' }, { v: '2K', label: '2K (Gemini)' }, { v: '4K', label: '4K (Gemini)' },
];
const VIDEO_SIZES = ['', '480p', '720p', '1080p', '640x480', '1280x720', '1920x1080', '720x1280'];
const VIDEO_SECONDS = [0, 3, 5, 8, 10];

export class MediaPane {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  #media-pane
   * @param {Function} o.getWs         () => workspace
   * @param {Function}[o.onMedia]      (media) => void — mirror a result into the chat transcript
   * @param {Function}[o.openFile]     (path) => void
   */
  constructor(o) {
    Object.assign(this, o);
    this.kind = 'image';
    this.history = [];
    this.busy = false;
    this.build();
  }

  build() {
    const c = this.container;
    c.innerHTML = '';

    /* ── kind switch ─────────────────────────────────── */
    const imgTab = el('button.seg.active', { text: 'Image' });
    const vidTab = el('button.seg', { text: 'Video' });
    imgTab.onclick = () => this.setKind('image');
    vidTab.onclick = () => this.setKind('video');
    this.seg = el('div.seg-row', {}, imgTab, vidTab);
    this.imgTab = imgTab; this.vidTab = vidTab;

    /* ── prompt ──────────────────────────────────────── */
    this.prompt = el('textarea.inp', {
      rows: 4, spellcheck: 'false',
      placeholder: 'A neon-lit alley in the rain, cinematic, 35mm, reflections on wet asphalt…',
    });
    this.negative = el('input.inp', { type: 'text', placeholder: 'what to avoid (optional)' });

    /* ── model + options ─────────────────────────────── */
    this.modelSel = el('select.inp', {});
    this.customModel = el('input.inp.mono', { type: 'text', placeholder: '…or type a model id' });
    this.providerSel = el('select.inp', {});
    this.qualitySel = el('select.inp', {});
    this.ratioSel = el('select.inp', {});
    this.sizeSel = el('select.inp', {});
    this.secondsSel = el('select.inp', {});
    this.audioCheck = el('input', { type: 'checkbox' });
    this.testCheck = el('input', { type: 'checkbox' });
    this.testCheck.checked = true;   // default to the credit-free sample: no surprises

    /* ── reference media ─────────────────────────────── */
    this.refSel = el('select.inp', {});
    const refBrowse = el('button.btn.tiny', { text: 'upload…' });
    const refFile = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    refBrowse.onclick = () => refFile.click();
    refFile.onchange = async () => {
      const f = refFile.files?.[0];
      if (!f) return;
      try {
        const path = `media/refs/${f.name.replace(/[^\w.\-]+/g, '_')}`;
        await this.getWs().write(path, f);
        await this.loadRefs();
        this.refSel.value = path;
        toast(`Reference saved to ${path}`, { type: 'ok' });
      } catch (e) { toast(prettyError(e), { type: 'err' }); }
      refFile.value = '';
    };

    /* ── generate ────────────────────────────────────── */
    this.genBtn = el('button.btn.primary.wide', {}, icon('sparkles'), el('span', { text: 'Generate' }));
    this.genBtn.onclick = () => this.generate();
    this.status = el('div.hint', { style: { minHeight: '18px' } });

    this.imageOpts = el('div.opt-grid', {},
      field('Quality / size', this.qualitySel),
      field('Aspect ratio', this.ratioSel),
    );
    this.videoOpts = el('div.opt-grid', {},
      field('Output size', this.sizeSel),
      field('Seconds', this.secondsSel),
      el('label.checkline', {}, this.audioCheck, el('span', { text: 'Generate soundtrack (Seedance)' })),
    );

    c.append(
      el('div.card', {},
        el('h4', {}, icon('sparkles'), el('span', { text: 'Create' })),
        this.seg,
        el('label.lbl', { text: 'Prompt' }),
        this.prompt,
        el('label.lbl', { style: { marginTop: '8px' }, text: 'Negative prompt' }),
        this.negative,
        el('div.opt-grid', { style: { marginTop: '10px' } },
          field('Model', this.modelSel),
          field('Provider', this.providerSel),
        ),
        this.customModel,
        this.imageOpts,
        this.videoOpts,
        el('label.lbl', { style: { marginTop: '10px' }, text: 'Reference (image-to-image / first frame)' }),
        el('div.row', {}, this.refSel, refBrowse, refFile),
        el('label.checkline', { style: { marginTop: '10px' } }, this.testCheck,
          el('span', {}, el('b', { text: 'Free sample' }), el('span', { text: ' — test mode returns a sample and spends no credits' }))),
        el('div', { style: { marginTop: '10px' } }, this.genBtn),
        this.status,
      ),
      this.resultCard(),
      el('div.card', {},
        el('h4', {}, icon('clock'), el('span', { text: 'This session' })),
        this.historyEl = el('div.media-history'),
        el('p.hint', { text: 'Generations are saved into the workspace under media/ — they survive a reload there, not in this list.' }),
      ),
    );

    this.fillModels();
    this.loadRefs();
    this.setKind('image');
  }

  resultCard() {
    this.resultBody = el('div.media-result');
    this.resultMeta = el('div.hint');
    return this.result = el('div.card', { hidden: true },
      el('h4', {}, icon('image'), el('span', { text: 'Result' })),
      this.resultBody,
      this.resultMeta,
    );
  }

  /* ── state ─────────────────────────────────────────── */
  setKind(kind) {
    this.kind = kind;
    this.imgTab.classList.toggle('active', kind === 'image');
    this.vidTab.classList.toggle('active', kind === 'video');
    this.imageOpts.hidden = kind !== 'image';
    this.videoOpts.hidden = kind !== 'video';
    this.genBtn.querySelector('span').textContent = kind === 'image' ? 'Generate image' : 'Generate video';
    this.prompt.placeholder = kind === 'image'
      ? 'A neon-lit alley in the rain, cinematic, 35mm, reflections on wet asphalt…'
      : 'A drone shot over a coastline at sunrise, slow push-in, gulls crossing the frame…';
    this.fillModels();
  }

  fillModels() {
    const list = this.kind === 'image' ? IMAGE_MODELS : VIDEO_MODELS;
    this.modelSel.replaceChildren(...list.map((m) => el('option', { value: m.id, text: m.label })));
    const provs = this.kind === 'image' ? IMAGE_PROVIDERS : VIDEO_PROVIDERS;
    this.providerSel.replaceChildren(
      el('option', { value: '', text: 'auto' }),
      ...provs.map((p) => el('option', { value: p, text: p })),
    );
    this.qualitySel.replaceChildren(...IMAGE_QUALITY.map((q) => el('option', { value: q.v, text: q.label })));
    this.ratioSel.replaceChildren(...IMAGE_RATIOS.map((r) => el('option', { value: r, text: r || 'default' })));
    this.sizeSel.replaceChildren(...VIDEO_SIZES.map((s) => el('option', { value: s, text: s || 'default' })));
    this.secondsSel.replaceChildren(...VIDEO_SECONDS.map((s) => el('option', { value: String(s), text: s ? `${s}s` : 'model default' })));
  }

  /** Every image in the workspace becomes an available reference / first frame. */
  async loadRefs() {
    try {
      const entries = await this.getWs().list();
      const imgs = entries.filter((e) => e.type === 'file' && /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(e.path));
      const keep = this.refSel.value;
      this.refSel.replaceChildren(
        el('option', { value: '', text: 'none (text-to-' + (this.kind === 'image' ? 'image)' : 'video)') }),
        ...imgs.map((e) => el('option', { value: e.path, text: `${e.path} (${formatBytes(e.size || 0)})` })),
      );
      if (keep && [...this.refSel.options].some((o) => o.value === keep)) this.refSel.value = keep;
    } catch { /* workspace not ready yet */ }
  }

  /* ── generate ──────────────────────────────────────── */
  async generate() {
    if (this.busy) return;
    const prompt = this.prompt.value.trim();
    if (!prompt) { toast('Write a prompt first'); this.prompt.focus(); return; }

    const model = this.customModel.value.trim() || this.modelSel.value || undefined;
    const provider = this.providerSel.value || undefined;
    const testMode = this.testCheck.checked;
    const refPath = this.refSel.value;

    this.busy = true;
    this.genBtn.disabled = true;
    const t0 = performance.now();
    this.setStatus(testMode ? 'Generating a free sample…' : 'Generating…');

    try {
      let media;
      if (this.kind === 'image') {
        media = await generateImage({
          prompt, model, provider, testMode,
          quality: this.qualitySel.value || undefined,
          aspectRatio: this.ratioSel.value || undefined,
          negativePrompt: this.negative.value.trim() || undefined,
          referenceImage: refPath ? await workspaceFileToDataUrl(this.getWs(), refPath) : undefined,
        });
      } else {
        media = await generateVideo({
          prompt, model, provider, testMode,
          size: this.sizeSel.value || undefined,
          seconds: Number(this.secondsSel.value) || undefined,
          negativePrompt: this.negative.value.trim() || undefined,
          generateAudio: this.audioCheck.checked || undefined,
          firstFrame: refPath ? await workspaceFileToDataUrl(this.getWs(), refPath) : undefined,
        });
      }

      const path = `media/${this.kind}-${Date.now().toString(36)}.${media.ext}`;
      await this.getWs().write(path, media.blob);
      this.setStatus(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${formatBytes(media.blob.size)}`);
      this.showResult({ ...media, path, prompt });
      this.pushHistory({ ...media, path, prompt });
      this.onMedia?.({ kind: media.kind, path, dataUrl: media.dataUrl, model: media.model, prompt, testMode });
      this.loadRefs();
    } catch (e) {
      this.setStatus('');
      toast(prettyError(e), { type: 'err', timeout: 8000 });
    } finally {
      this.busy = false;
      this.genBtn.disabled = false;
    }
  }

  setStatus(text) { this.status.textContent = text; }

  showResult(media) {
    this.result.hidden = false;
    this.resultBody.replaceChildren(
      media.kind === 'video'
        ? el('video', { src: media.url, controls: true, playsinline: true, autoplay: true })
        : el('img', { src: media.url, alt: media.prompt || 'generated image' }),
    );
    const row = el('div.row.wrap', { style: { marginTop: '8px' } },
      el('button.btn.tiny', { text: 'download', onclick: () => downloadBlob(media.blob, basename(media.path)) }),
      el('button.btn.tiny', { text: 'open in Files', onclick: () => this.openFile?.(media.path) }),
      el('button.btn.tiny', {
        text: media.kind === 'image' ? 'use as reference' : 'use as first frame',
        onclick: async () => { await this.loadRefs(); this.refSel.value = media.path; toast('Reference set', { type: 'ok' }); },
      }),
      media.testMode ? el('span.tag.free', { text: 'free sample — no credits used' }) : null,
    );
    this.resultMeta.replaceChildren(
      el('div', { text: `${media.path} · ${media.model}` }),
      row,
    );
  }

  pushHistory(media) {
    this.history.unshift(media);
    this.history = this.history.slice(0, 12);
    this.historyEl.replaceChildren(...this.history.map((m) => {
      const thumb = el('button.media-thumb', { title: `${m.path}\n${m.prompt || ''}` },
        m.kind === 'video' ? el('span.video-badge', { text: '▶' }) : null,
        m.kind === 'video' ? null : el('img', { src: m.url, alt: '' }),
      );
      thumb.onclick = () => this.showResult(m);
      return thumb;
    }));
  }
}

function field(label, control) {
  return el('label.field', {}, el('span.lbl', { text: label }), control);
}
