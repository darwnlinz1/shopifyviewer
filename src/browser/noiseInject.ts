/**
 * src/browser/noiseInject.ts
 *
 * Seeded deterministic micro-noise injector for Canvas 2D, WebGL, and AudioContext (V2.0.0 Architecture).
 *
 * Guarantees:
 *  1. Uniqueness: Profile A (Seed 1111) != Profile B (Seed 2222)
 *  2. Consistency: Profile A Call #1 === Profile A Call #2 (No inconsistent hash detection)
 *  3. Inaudible/Invisible: ±1 color bit on visible pixels, 1e-7 audio amplitude.
 *  4. Native Descriptor Invariant: 100% native function signature, length, toString, and no .prototype leak (ES6 Method Shorthand).
 */

export function buildNoiseScript(seed: number): string {
  const safeSeed = Math.abs(seed) || 1234567;
  return `(() => {
    if (window.__noise_injected_v2__) return;
    window.__noise_injected_v2__ = true;

    const SEED = ${safeSeed};

    function createPrng(s) {
      let state = s | 0;
      return function() {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const register = (fn, name, length = 0) => {
      if (typeof fn === 'function') {
        const REG_SYM = Symbol.for('__v8_native_reg__');
        const REG_FN_SYM = Symbol.for('__v8_reg_fn__');
        if (window[REG_FN_SYM]) {
          window[REG_FN_SYM](fn, name, length);
        } else if (window[REG_SYM]) {
          window[REG_SYM].set(fn, name);
        }
      }
      return fn;
    };

    function applyNoiseToPixelData(data, sw, sh, seedVal) {
      if (!data || data.length === 0 || data.length > 16000000) return;
      const rowPrng = createPrng(seedVal ^ (sw * 31 + sh));
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha > 0 && alpha < 255 && rowPrng() > 0.6) {
          const shift = rowPrng() > 0.5 ? 1 : -1;
          data[i] = Math.min(255, Math.max(0, data[i] + shift));
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + shift));
          data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + shift));
        }
      }
    }

    // ── 1. Canvas 2D & OffscreenCanvas (ES6 Object Methods: No .prototype leak) ──
    if (typeof CanvasRenderingContext2D !== 'undefined') {
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      const canvasMethods = {
        getImageData(sx, sy, sw, sh, settings) {
          const imgData = origGetImageData.call(this, sx, sy, sw, sh, settings);
          try {
            applyNoiseToPixelData(imgData.data, sw, sh, SEED);
          } catch(e) {}
          return imgData;
        }
      };
      register(canvasMethods.getImageData, 'getImageData', 4);
      CanvasRenderingContext2D.prototype.getImageData = canvasMethods.getImageData;
    }

    if (typeof HTMLCanvasElement !== 'undefined') {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      const htmlCanvasMethods = {
        toDataURL(...args) {
          try {
            const w = this.width, h = this.height;
            if (w && h && w * h < 600000) {
              const copy = document.createElement('canvas');
              copy.width = w;
              copy.height = h;
              const copyCtx = copy.getContext('2d');
              if (copyCtx) {
                copyCtx.drawImage(this, 0, 0);
                const img = copyCtx.getImageData(0, 0, w, h);
                applyNoiseToPixelData(img.data, w, h, SEED);
                copyCtx.putImageData(img, 0, 0);
                return origToDataURL.apply(copy, args);
              }
            }
          } catch (e) {}
          return origToDataURL.apply(this, args);
        }
      };
      register(htmlCanvasMethods.toDataURL, 'toDataURL', 0);
      HTMLCanvasElement.prototype.toDataURL = htmlCanvasMethods.toDataURL;
    }

    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
      const origOffscreenGetImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
      const offscreenMethods = {
        getImageData(sx, sy, sw, sh, settings) {
          const imgData = origOffscreenGetImageData.call(this, sx, sy, sw, sh, settings);
          try {
            applyNoiseToPixelData(imgData.data, sw, sh, SEED);
          } catch(e) {}
          return imgData;
        }
      };
      register(offscreenMethods.getImageData, 'getImageData', 4);
      OffscreenCanvasRenderingContext2D.prototype.getImageData = offscreenMethods.getImageData;
    }

    // ── 2. WebGL ReadPixels Micro-Noise ──────────────────────────────────────
    function patchGlReadPixels(proto) {
      if (!proto || !proto.readPixels) return;
      const origReadPixels = proto.readPixels;
      const glMethods = {
        readPixels(x, y, w, h, format, type, pixels) {
          origReadPixels.call(this, x, y, w, h, format, type, pixels);
          try {
            if (pixels && pixels.length > 0) {
              const glPrng = createPrng(SEED ^ 0x5a5a5a5a);
              for (let i = 0; i < pixels.length; i += 16) {
                if (glPrng() > 0.85) {
                  const shift = glPrng() > 0.5 ? 1 : -1;
                  pixels[i] = Math.min(255, Math.max(0, pixels[i] + shift));
                }
              }
            }
          } catch(e) {}
        }
      };
      register(glMethods.readPixels, 'readPixels', 7);
      proto.readPixels = glMethods.readPixels;
    }
    if (typeof WebGLRenderingContext !== 'undefined') patchGlReadPixels(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchGlReadPixels(WebGL2RenderingContext.prototype);

    // ── 3. AudioContext & OfflineAudioContext DSP Noise ──────────────────────
    if (typeof AudioBuffer !== 'undefined') {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      const audioMethods = {
        getChannelData(channel) {
          const data = origGetChannelData.call(this, channel);
          try {
            const audioPrng = createPrng(SEED ^ (channel * 17 + 0x3c3c3c3c));
            for (let i = 0; i < data.length; i += 64) {
              data[i] += (audioPrng() - 0.5) * 1e-7;
            }
          } catch(e) {}
          return data;
        }
      };
      register(audioMethods.getChannelData, 'getChannelData', 1);
      AudioBuffer.prototype.getChannelData = audioMethods.getChannelData;
    }

    if (typeof OfflineAudioContext !== 'undefined') {
      const origStartRendering = OfflineAudioContext.prototype.startRendering;
      const offlineAudioMethods = {
        startRendering() {
          return origStartRendering.call(this).then(renderedBuffer => {
            try {
              const audioPrng = createPrng(SEED ^ 0x7e7e7e7e);
              const channelCount = renderedBuffer.numberOfChannels;
              for (let c = 0; c < channelCount; c++) {
                const channelData = renderedBuffer.getChannelData(c);
                for (let i = 0; i < channelData.length; i += 64) {
                  channelData[i] += (audioPrng() - 0.5) * 1e-7;
                }
              }
            } catch(e) {}
            return renderedBuffer;
          });
        }
      };
      register(offlineAudioMethods.startRendering, 'startRendering', 0);
      OfflineAudioContext.prototype.startRendering = offlineAudioMethods.startRendering;
    }
  })();`;
}
