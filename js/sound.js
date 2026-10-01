import * as THREE from 'three';

/**
 * One recorded clip drives both interactions, so the two are distinguished by
 * playback rate rather than by separate assets. Rate changes pitch *and*
 * duration together, which is what makes a lift read as a lift and a set-down as
 * a set-down from the same waveform.
 *
 * The pickup is pitched up and trimmed short: a light, rising "lift". The place
 * is pitched down and allowed to ring longer: a heavier, settling "thud". The
 * slight offset on the place also skips the clip's attack transient, which is
 * shaped for the pickup and sounds like a click at this rate.
 */
const CUES = {
  pickup: { rate: 1.45, gain: 0.55, offset: 0 },
  place: { rate: 0.75, gain: 0.7, offset: 0.04 },
};

// A new source node per play, rather than restarting one shared node. Restarting
// a single node truncates the previous sound mid-waveform, which clicks on a
// short percussive clip like this one; this way a fast pick-up/place pair
// overlaps cleanly instead.
const MAX_VOICES = 6;

export class GameSounds {
  /**
   * @param {THREE.Camera} camera  the listener is parented to this
   * @param {string} url           path to the clip
   */
  constructor(camera, url) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    // Cached once. Creating the listener already built the native context, and
    // re-reading it per cue would be a needless lookup on a tap-critical path.
    this.context = this.listener.context;

    this.voices = [];
    this.buffer = null;

    // Mobile browsers hand back a suspended AudioContext and refuse to make any
    // noise until a real gesture. Without this the very first pick-up is always
    // silent. Resuming on the same tap that triggers the interaction would be too
    // late, so the context is unlocked eagerly on any input and the cue is only
    // skipped if it is genuinely still suspended by the time it fires.
    //
    // The context is read off the listener's own `context` property. In 0.186 the
    // getter moved to the static THREE.AudioContext.getContext(), and
    // AudioListener no longer has a getContext() instance method at all.
    const unlock = () => {
      const ctx = this.context;
      if (ctx && ctx.state === 'suspended') ctx.resume();
    };
    for (const evt of ['pointerdown', 'touchstart', 'keydown']) {
      window.addEventListener(evt, unlock, { passive: true });
    }

    this.loader = new THREE.AudioLoader();
    this.loader.load(url, (buffer) => {
      this.buffer = buffer;
    });
  }

  /**
   * @param {'pickup'|'place'} cue
   */
  play(cue) {
    const cfg = CUES[cue];
    if (!cfg || !this.buffer) return;

    // Same reason as above: this context is the listener's, not a fresh getter.
    if (!this.context || this.context.state !== 'running') return;

    // Retire finished voices, and cap the count so a held-down action button
    // cannot pile up sources faster than they expire.
    this.voices = this.voices.filter((v) => v.isPlaying);
    if (this.voices.length >= MAX_VOICES) {
      const oldest = this.voices.shift();
      if (oldest && oldest.isPlaying) oldest.stop();
    }

    const voice = new THREE.Audio(this.listener);
    voice.setBuffer(this.buffer);
    voice.setPlaybackRate(cfg.rate);
    voice.setVolume(cfg.gain);
    voice.offset = cfg.offset;
    voice.play();
    this.voices.push(voice);
  }
}