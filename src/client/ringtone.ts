/**
 * Ringtone, synthesised rather than shipped as an audio file.
 *
 * Two reasons for WebAudio over an <audio src="ring.mp3">:
 *
 *  1. No asset to host, cache-bust, or licence. Note the licence point is not
 *     hypothetical: the stock smartphone ringtones people ask for are
 *     copyrighted recordings AND copyrighted compositions. `marimba` below is
 *     the marimba TIMBRE with a pattern of our own, not a transcription of
 *     anyone's ringtone.
 *
 *  2. An <audio> element that fails to load fails SILENTLY, and a softphone
 *     whose ring is quietly broken is worse than one with no ring at all.
 *     An oscillator either runs or throws.
 */

export type RingPattern = 'classic' | 'marimba';

interface PatternSpec {
  /** Seconds for one full repetition, including the trailing silence. */
  cycle: number;
  schedule(r: Ringtone, at: number): void;
}

const SEMITONE = 2 ** (1 / 12);

/** Equal-temperament frequency, `semitones` away from the given root. */
const step = (root: number, semitones: number) => root * SEMITONE ** semitones;

const PATTERNS: Record<RingPattern, PatternSpec> = {
  /**
   * Indian/UK PSTN double-ring: two ~0.4s bursts of 400+450 Hz beating against
   * each other, then a long gap. Sounds like a desk phone, which is the point —
   * an agent should not confuse it with a notification.
   */
  classic: {
    cycle: 0.4 + 0.2 + 0.4 + 2.0,
    schedule(r, at) {
      const burst = (start: number) => {
        for (const hz of [400, 450]) r.tone(hz, start, 0.4, 0.09, 'sine');
      };
      burst(at);
      burst(at + 0.6);
    },
  },

  /**
   * Marimba-style arpeggio — the bright, wooden, fast-decay sound modern phones
   * use. A marimba's character comes from a strong 4th partial (two octaves and
   * a major third up) over a fast exponential decay, so each note here is two
   * stacked sines with that ratio.
   *
   * The figure is a major-pentatonic rise and fall, repeated twice per cycle.
   * Deliberately not anyone's shipped melody.
   */
  marimba: {
    cycle: 2.6,
    schedule(r, at) {
      const root = 523.25; // C5 — bright enough to cut through a headset
      const figure = [0, 4, 7, 12, 7, 4]; // major pentatonic up and back
      const gap = 0.13;

      figure.forEach((semi, i) => {
        r.marimbaNote(step(root, semi), at + i * gap);
      });
      // Second pass a fifth up, so the two halves answer each other.
      figure.forEach((semi, i) => {
        r.marimbaNote(step(root, semi + 7), at + 0.95 + i * gap);
      });
    },
  },
};

export class Ringtone {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private pattern: RingPattern;

  /** Nodes from scheduled voices, released once they have finished sounding. */
  private voices: AudioScheduledSourceNode[] = [];

  constructor(pattern: RingPattern = 'classic') {
    this.pattern = pattern;
  }

  /**
   * True once the browser has let us actually make sound. Autoplay policy
   * suspends a context created without a user gesture, so this can be false
   * even after start() resolves — surface it rather than pretending we rang.
   */
  get audible(): boolean {
    return this.playing && this.ctx?.state === 'running';
  }

  setPattern(pattern: RingPattern): void {
    if (pattern === this.pattern) return;
    this.pattern = pattern;
    // Restart so a change made mid-ring is heard immediately.
    if (this.playing) {
      this.stop();
      void this.start();
    }
  }

  /**
   * Call from any user gesture (a click anywhere) to unlock audio ahead of the
   * first call. Without this the first ring of a session may be silent.
   */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  }

  async start(): Promise<void> {
    if (this.playing) return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(ctx.destination);
    this.playing = true;

    const spec = PATTERNS[this.pattern];
    spec.schedule(this, ctx.currentTime + 0.05);
    // Re-arm slightly early so there is no audible seam between cycles.
    this.timer = setInterval(
      () => this.playing && spec.schedule(this, this.ctx!.currentTime + 0.02),
      spec.cycle * 1000 - 60,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;

    // Ramp the bus down before killing voices: cutting a running oscillator
    // dead produces a click, which sounds like a fault.
    if (this.ctx && this.out) {
      const now = this.ctx.currentTime;
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setValueAtTime(this.out.gain.value, now);
      this.out.gain.linearRampToValueAtTime(0, now + 0.04);
    }

    const dying = this.voices;
    this.voices = [];
    setTimeout(() => {
      dying.forEach((v) => {
        try {
          v.stop();
          v.disconnect();
        } catch {
          /* already finished */
        }
      });
    }, 80);
  }

  /** Release the audio device. Call on unmount. */
  dispose(): void {
    this.stop();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  // -------------------------------------------------------------------------
  // Voice primitives, used by the pattern specs
  // -------------------------------------------------------------------------

  /** A flat-topped tone with short attack and release — telephone-like. */
  tone(hz: number, at: number, duration: number, peak: number, type: OscillatorType): void {
    const ctx = this.ctx;
    const bus = this.out;
    if (!ctx || !bus) return;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = hz;

    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.02);
    g.gain.setValueAtTime(peak, at + duration - 0.02);
    g.gain.linearRampToValueAtTime(0, at + duration);

    osc.connect(g).connect(bus);
    osc.start(at);
    osc.stop(at + duration + 0.02);
    this.track(osc);
  }

  /** Struck-wood note: instant attack, exponential decay, strong 4th partial. */
  marimbaNote(hz: number, at: number): void {
    const ctx = this.ctx;
    const bus = this.out;
    if (!ctx || !bus) return;

    const decay = 0.55;
    // Marimba bars are tuned so the first overtone sits two octaves above the
    // fundamental — a 4:1 ratio. (A xylophone is tuned 3:1, which is why it
    // sounds harder and more hollow.) That partial is what makes this read as
    // struck wood rather than as a plain sine beep.
    const partials: Array<[number, number]> = [
      [1, 0.2],
      [4, 0.05],
    ];

    for (const [ratio, peak] of partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz * ratio;

      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.006);
      // exponentialRamp cannot reach 0, so decay to a floor then cut.
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);

      osc.connect(g).connect(bus);
      osc.start(at);
      osc.stop(at + decay + 0.02);
      this.track(osc);
    }
  }

  private track(node: AudioScheduledSourceNode): void {
    this.voices.push(node);
    node.onended = () => {
      this.voices = this.voices.filter((v) => v !== node);
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext();
    return this.ctx;
  }
}
