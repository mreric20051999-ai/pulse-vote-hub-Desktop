// Shared Web Audio feedback — success chime, error buzz, confirm tick.
// Dependency-free (synthesized oscillators, no asset files). Load on any page
// that needs sound; exposes window.pvhAudio.{playSuccess,playError,playConfirm,tone}.
(function () {
  let ctx = null;

  // Respect Preferences > Sound effects (pvh_prefs stored by common.js).
  function soundEnabled() {
    try {
      const p = JSON.parse(window.localStorage.getItem('pvh_prefs') || '{}');
      return p.sound !== 'off';
    } catch (e) {
      return true;
    }
  }

  function audio() {
    if (!soundEnabled()) return null;
    if (!ctx) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        ctx = new Ctx();
      } catch (e) {
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // One oscillator tone with an attack/decay envelope.
  function tone(freq, type, startIn, dur, vol, nextFreq) {
    const c = audio();
    if (!c) return;
    try {
      const t = c.currentTime + startIn;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (typeof nextFreq === 'number') osc.frequency.exponentialRampToValueAtTime(nextFreq, t + dur);
      const v = vol == null ? 0.35 : vol;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(v, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    } catch (e) { /* audio unavailable */ }
  }

  // "Your vote has been recorded" — pleasant two-tone chime (660 -> 880 Hz).
  function playSuccess() {
    tone(660, 'sine', 0, 0.5, 0.35);
    tone(880, 'sine', 0.15, 0.5, 0.32);
  }

  // Soft confirm tick for positive but secondary actions.
  function playConfirm() {
    tone(520, 'sine', 0, 0.18, 0.22);
  }

  // Error / blocked — short low buzz, then a lower fall.
  function playError() {
    tone(220, 'square', 0, 0.18, 0.18);
    tone(160, 'square', 0.16, 0.3, 0.16);
  }

  window.pvhAudio = { tone, playSuccess, playConfirm, playError };
})();