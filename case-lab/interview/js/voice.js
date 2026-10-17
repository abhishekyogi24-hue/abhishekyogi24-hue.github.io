/* Mock interview — voice. Text-to-speech (browser, optional ElevenLabs) and speech-to-text wrapper.
   Chrome gotchas handled here: long utterances get cut (~15s) so we speak per sentence;
   voices load asynchronously; SpeechRecognition stops itself after silence so we restart it. */

/* ============================== Sentence chunking ============================== */
const ABBREV_WORDS = /\b(?:mr|mrs|ms|dr|vs|etc|e\.g|i\.e|inc|st|approx)\.$/i;
const ABBREV_INITIAL = /(?:^|[\s(.])[A-Z]\.$/;   // "U.S.", "J. Smith"

/* Pull completed sentences off the front of a streaming buffer. Returns { sentences, rest }. */
export function splitSentences(buffer) {
  const sentences = [];
  let start = 0;
  const re = /[.!?]+["')\]]*\s+|\n+/g;
  let m;
  while ((m = re.exec(buffer))) {
    const isNewline = m[0][0] === '\n';
    const candidate = buffer.slice(start, m.index + (isNewline ? 0 : m[0].trimEnd().length)).trim();
    if (!isNewline && (ABBREV_WORDS.test(candidate) || ABBREV_INITIAL.test(candidate))) continue; // not a real sentence end
    if (candidate) sentences.push(candidate);
    start = m.index + m[0].length;
  }
  return { sentences, rest: buffer.slice(start) };
}

/* ============================== Voices ============================== */
export function ttsSupported() { return typeof window !== 'undefined' && 'speechSynthesis' in window; }

export function loadVoices() {
  return new Promise(resolve => {
    if (!ttsSupported()) return resolve([]);
    const have = speechSynthesis.getVoices();
    if (have.length) return resolve(have);
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(speechSynthesis.getVoices()); };
    speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, 1500);
  });
}

const GROUP_ORDER = ['en-IN', 'en-US', 'en-GB', 'en-AU', 'other'];
export function groupVoices(voices) {
  const groups = {};
  GROUP_ORDER.forEach(g => { groups[g] = []; });
  voices.forEach(v => {
    const lang = (v.lang || '').replace('_', '-');
    const key = GROUP_ORDER.includes(lang) ? lang : 'other';
    groups[key].push(v);
  });
  GROUP_ORDER.forEach(g => groups[g].sort((a, b) => a.name.localeCompare(b.name)));
  return groups;
}

export function defaultVoiceFor(voices, lang) {
  const norm = v => (v.lang || '').replace('_', '-');
  return voices.find(v => norm(v) === lang) || voices.find(v => norm(v).startsWith(lang.slice(0, 2))) || voices[0] || null;
}

/* ============================== Speaker (TTS) ============================== */
export class Speaker {
  /* opts: { engine, voiceURI, rate, pitch, volume, lang, elevenKey, elevenVoiceId, onState(speaking), onWarn(msg) } */
  constructor(opts = {}) {
    this.opts = Object.assign({ engine: 'browser', rate: 1, pitch: 1, volume: 1, lang: 'en-IN' }, opts);
    this.buffer = '';
    this.queue = [];          // { text, audio: Promise<Blob>|null }
    this.playing = false;
    this.paused = false;
    this.gen = 0;             // bumps on cancel so stale callbacks do nothing
    this.idleWaiters = [];
    this.audioEl = null;
    this.warned = false;
  }

  configure(opts) { Object.assign(this.opts, opts); }
  get busy() { return this.playing || this.queue.length > 0; }

  /* Feed streamed text; complete sentences are queued immediately. */
  feed(text) {
    this.buffer += text;
    const { sentences, rest } = splitSentences(this.buffer);
    this.buffer = rest;
    sentences.forEach(s => this._enqueue(s));
  }
  /* End of stream: speak whatever remains. */
  flush() {
    const s = this.buffer.trim();
    this.buffer = '';
    if (s) this._enqueue(s);
    this._maybeIdle();
  }
  /* Speak a complete string (preview button, canned lines). */
  say(text) { this.feed(text + ' '); this.flush(); }

  cancel() {
    this.gen++;
    this.buffer = '';
    this.queue = [];
    this.playing = false;
    this.paused = false;
    if (ttsSupported()) speechSynthesis.cancel();
    if (this.audioEl) { try { this.audioEl.pause(); } catch (e) { /* ignore */ } this.audioEl = null; }
    this._emitState(false);
    this._resolveIdle();
  }

  pause() {
    this.paused = true;
    if (ttsSupported()) speechSynthesis.pause();
    if (this.audioEl) this.audioEl.pause();
  }
  resume() {
    this.paused = false;
    if (ttsSupported()) speechSynthesis.resume();
    if (this.audioEl) this.audioEl.play().catch(() => {});
  }

  /* Resolves when the queue is drained (and the stream has been flushed). */
  whenIdle() {
    if (!this.busy && !this.buffer.trim()) return Promise.resolve();
    return new Promise(res => this.idleWaiters.push(res));
  }

  _emitState(speaking) { if (this.opts.onState) this.opts.onState(speaking); }
  _resolveIdle() { const w = this.idleWaiters; this.idleWaiters = []; w.forEach(r => r()); }
  _maybeIdle() { if (!this.busy && !this.buffer.trim()) this._resolveIdle(); }

  _enqueue(text) {
    if (this.opts.engine === 'off' || !/[A-Za-z0-9]/.test(text)) return;
    const item = { text, audio: null };
    if (this.opts.engine === 'eleven' && this.opts.elevenKey && this.opts.elevenVoiceId) item.audio = this._fetchEleven(text);
    this.queue.push(item);
    if (!this.playing) this._next();
  }

  async _next() {
    if (this.playing) return;
    const item = this.queue.shift();
    if (!item) { this._emitState(false); this._resolveIdle(); return; }
    this.playing = true;
    this._emitState(true);
    const gen = this.gen;
    try {
      if (item.audio) {
        try { await this._playBlob(await item.audio, gen); }
        catch (e) {
          if (gen !== this.gen) return;
          this._warn('ElevenLabs failed (' + (e && e.message ? e.message : 'error') + '). Using the browser voice instead.');
          await this._speakBrowser(item.text, gen);
        }
      } else {
        await this._speakBrowser(item.text, gen);
      }
    } finally {
      if (gen === this.gen) { this.playing = false; this._next(); }
    }
  }

  _warn(msg) { if (!this.warned && this.opts.onWarn) { this.warned = true; this.opts.onWarn(msg); } }

  _speakBrowser(text, gen) {
    return new Promise(resolve => {
      if (!ttsSupported()) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const v = voices.find(x => x.voiceURI === this.opts.voiceURI) || defaultVoiceFor(voices, this.opts.lang);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = this.opts.lang;
      u.rate = this.opts.rate; u.pitch = this.opts.pitch; u.volume = this.opts.volume;
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(guard); resolve(); };
      // Chrome sometimes never fires onend; guard with a length-based timeout.
      const guard = setTimeout(done, Math.max(4000, (text.length * 110) / Math.max(0.5, this.opts.rate)) + 3000);
      u.onend = done; u.onerror = done;
      if (gen !== this.gen) return done();
      speechSynthesis.speak(u);
    });
  }

  async _fetchEleven(text) {
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(this.opts.elevenVoiceId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': this.opts.elevenKey },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.blob();
  }

  _playBlob(blob, gen) {
    return new Promise((resolve, reject) => {
      if (gen !== this.gen) return resolve();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.volume = Math.min(1, this.opts.volume);
      a.playbackRate = this.opts.rate;
      this.audioEl = a;
      const cleanup = () => { URL.revokeObjectURL(url); if (this.audioEl === a) this.audioEl = null; };
      a.onended = () => { cleanup(); resolve(); };
      a.onerror = () => { cleanup(); reject(new Error('audio playback error')); };
      a.play().catch(err => { cleanup(); reject(err); });
    });
  }
}

/* ============================== Listener (STT) ============================== */
export function sttSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class Listener {
  /* handlers: onResult(finalChunk, interim), onStatus('listening'|'idle'), onError(message) */
  constructor(handlers = {}) {
    this.h = handlers;
    this.rec = null;
    this.want = false;
    this.lang = 'en-IN';
  }

  start(lang) {
    if (!sttSupported()) return false;
    this.lang = lang || this.lang;
    this.want = true;
    this._spawn();
    return true;
  }

  /* Stops listening and keeps it stopped (no auto-restart). */
  stop() {
    this.want = false;
    if (this.rec) { try { this.rec.stop(); } catch (e) { /* ignore */ } }
  }

  _spawn() {
    if (!this.want || this.rec) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onstart = () => { if (this.h.onStatus) this.h.onStatus('listening'); };
    rec.onresult = (ev) => {
      let fin = '', interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript;
      }
      if (this.h.onResult) this.h.onResult(fin, interim);
    };
    rec.onerror = (ev) => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.want = false;
        if (this.h.onError) this.h.onError('Microphone access was blocked. Allow the mic for this site, or switch to text input.');
      } else if (ev.error === 'network') {
        if (this.h.onError) this.h.onError('Speech recognition lost its network connection. You can keep typing.');
      } else if (this.h.onError) this.h.onError('Speech recognition error: ' + ev.error);
    };
    rec.onend = () => {
      this.rec = null;
      if (this.h.onStatus) this.h.onStatus('idle');
      // Chrome ends recognition after silence; restart while the candidate is still answering.
      if (this.want) setTimeout(() => this._spawn(), 250);
    };
    this.rec = rec;
    try { rec.start(); } catch (e) { this.rec = null; }
  }
}
