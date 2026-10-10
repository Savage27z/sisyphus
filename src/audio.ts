// Tiny synthesized sound kit — no asset files needed for the prototype.
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;

  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.45 * this.volume;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Looping wind used for the falling "whoosh".
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuf;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();
  }

  /** Silences one-shot effects (the home-page demo); music keeps playing. */
  muted = false;

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, freqEnd?: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  hit(strength = 1): void {
    this.noise(0.12, 0.6 * strength, 1400);
    this.tone(130, 0.18, 'sine', 0.6 * strength, 45);
  }
  swing(): void {
    this.noise(0.09, 0.15, 3200);
  }
  shoot(): void {
    this.tone(420, 0.18, 'sawtooth', 0.12, 70);
    this.noise(0.12, 0.25, 2200);
  }
  gun(kind: 'blaster' | 'pushgun' | 'rocket' | 'railgun' | 'freeze'): void {
    switch (kind) {
      case 'blaster':
        this.tone(1100, 0.1, 'square', 0.08, 380);
        break;
      case 'pushgun':
        this.shoot();
        break;
      case 'rocket':
        this.noise(0.35, 0.35, 700);
        this.tone(180, 0.3, 'sawtooth', 0.12, 60);
        break;
      case 'railgun':
        this.tone(2400, 0.35, 'sine', 0.18, 140);
        this.noise(0.2, 0.25, 5200);
        break;
      case 'freeze':
        this.tone(1800, 0.25, 'triangle', 0.12, 2600);
        this.tone(2700, 0.2, 'sine', 0.08, 1900, 0.05);
        break;
    }
  }
  boom(): void {
    this.noise(0.5, 0.8, 300);
    this.tone(70, 0.5, 'sine', 0.8, 30);
  }
  boing(): void {
    this.tone(160, 0.4, 'sine', 0.4, 720);
  }
  clank(): void {
    this.tone(900, 0.08, 'square', 0.12);
    this.tone(520, 0.14, 'square', 0.1, undefined, 0.05);
  }
  place(): void {
    this.tone(300, 0.08, 'triangle', 0.2, 200);
  }
  thud(strength: number): void {
    this.tone(90, 0.2, 'sine', Math.min(0.7, 0.2 + strength * 0.5), 40);
  }
  pickup(): void {
    this.tone(660, 0.09, 'triangle', 0.25);
    this.tone(990, 0.14, 'triangle', 0.25, undefined, 0.08);
  }
  flagGrab(): void {
    this.tone(523, 0.12, 'square', 0.12);
    this.tone(784, 0.2, 'square', 0.12, undefined, 0.1);
  }
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.3, undefined, i * 0.12));
  }
  lose(): void {
    [392, 330, 262].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.25, undefined, i * 0.18));
  }

  // ---------------------------------------------------------------- music
  // A bright anime-pop loop generated on the fly: four-on-the-floor kick,
  // offbeat hats, bass, chord stabs and an arpeggiated lead over I–V–vi–IV.

  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private nextNote = 0;
  private step = 0;
  /** Set from the player's settings. */
  musicOn = true;
  private volume = 0.8;

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(0.45 * v, this.ctx.currentTime, 0.05);
  }

  startMusic(): void {
    const ctx = this.ctx;
    if (!ctx || this.musicTimer !== null || !this.musicOn) return;
    if (!this.musicGain) {
      this.musicGain = ctx.createGain();
      this.musicGain.connect(this.master);
    }
    this.musicGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.musicGain.gain.exponentialRampToValueAtTime(0.32, ctx.currentTime + 1.5);
    this.nextNote = ctx.currentTime + 0.1;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 25);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    this.musicTimer = null;
    if (this.ctx && this.musicGain) this.musicGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.2);
  }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (on) this.startMusic();
    else this.stopMusic();
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const eighth = 60 / 132 / 2;
    while (this.nextNote < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextNote);
      this.nextNote += eighth;
      this.step = (this.step + 1) % 64;
    }
  }

  private noteAt(t: number, midi: number, dur: number, type: OscillatorType, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(440 * Math.pow(2, (midi - 69) / 12), t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.musicGain!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private playStep(s: number, t: number): void {
    const ctx = this.ctx!;
    const bar = Math.floor(s / 8) % 4;
    const root = [48, 43, 45, 41][bar]; // C, G, Am, F
    const third = bar === 2 ? 3 : 4;
    // Kick on every beat.
    if (s % 2 === 0) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(g).connect(this.musicGain!);
      osc.start(t);
      osc.stop(t + 0.18);
    }
    // Offbeat hats.
    if (s % 2 === 1) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.connect(f).connect(g).connect(this.musicGain!);
      src.start(t, Math.random());
      src.stop(t + 0.06);
    }
    // Driving octave bass.
    this.noteAt(t, root - 12 + (s % 2 ? 12 : 0), 0.18, 'triangle', 0.22);
    // Chord stabs on the "and" of 2 and 4.
    if (s % 4 === 3) for (const iv of [12, 12 + third, 19]) this.noteAt(t, root + iv, 0.12, 'square', 0.035);
    // Arpeggiated lead, an octave up.
    const arp = [0, third, 7, 12, 7, third, 0, 7];
    this.noteAt(t, root + 24 + arp[s % 8], 0.16, 'triangle', bar === 3 && s % 8 > 5 ? 0.11 : 0.08);
  }

  /** 0..1 — loudness of the falling wind. */
  setWind(intensity: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.windGain.gain.setTargetAtTime(intensity * 0.4, t, 0.08);
    this.windFilter.frequency.setTargetAtTime(300 + intensity * 1000, t, 0.08);
  }
}
