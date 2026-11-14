(function(){
  'use strict';
  // 1. globalThis polyfill
  if (typeof globalThis === 'undefined') {
    if (typeof window !== 'undefined') window.globalThis = window;
    else if (typeof self !== 'undefined') self.globalThis = self;
    else if (typeof global !== 'undefined') global.globalThis = global;
    else (function(){ return this; })().globalThis = (function(){ return this; })();
  }

  // 2. crypto.getRandomValues polyfill
  if (typeof window !== 'undefined') {
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.getRandomValues) {
      window.crypto.getRandomValues = function (arr) {
        for (var i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      };
    }
  }

  // 3. Object.assign
  if (typeof Object.assign !== 'function') {
    Object.assign = function(target) {
      if (target == null) throw new TypeError('Target is null');
      var t = Object(target);
      for (var i = 1; i < arguments.length; i++) {
        var s = arguments[i];
        if (s != null) {
          for (var k in Object(s)) {
            if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
          }
        }
      }
      return t;
    };
  }

  // 4. Array.from & Object.values
  if (!Array.from) {
    Array.from = function(obj) { return Array.prototype.slice.call(obj); };
  }
  if (!Object.values) {
    Object.values = function(obj) { return Object.keys(obj).map(function(k){ return obj[k]; }); };
  }
  if (typeof ArrayBuffer !== 'undefined' && !ArrayBuffer.isView) {
    ArrayBuffer.isView = function(obj) {
      return !!(obj && obj.buffer instanceof ArrayBuffer);
    };
  }

  // 5. String helpers
  if (!String.prototype.padStart) {
    String.prototype.padStart = function(n, c) {
      var s = String(this);
      c = String(c || ' ');
      while (s.length < n) s = c + s;
      return s.slice(-n);
    };
  }
  if (!String.prototype.padEnd) {
    String.prototype.padEnd = function(n, c) {
      var s = String(this);
      c = String(c || ' ');
      while (s.length < n) s = s + c;
      return s.slice(0, n);
    };
  }
  if (!Array.prototype.includes) {
    Array.prototype.includes = function(v) { return this.indexOf(v) >= 0; };
  }
  if (!Array.prototype.find) {
    Array.prototype.find = function(fn, thisArg) {
      for (var i = 0; i < this.length; i++) {
        if (fn.call(thisArg, this[i], i, this)) return this[i];
      }
      return undefined;
    };
  }
  if (!Array.prototype.findIndex) {
    Array.prototype.findIndex = function(fn, thisArg) {
      for (var i = 0; i < this.length; i++) {
        if (fn.call(thisArg, this[i], i, this)) return i;
      }
      return -1;
    };
  }
  if (!Number.isSafeInteger) {
    Number.isSafeInteger = function(n) {
      return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && Math.abs(n) <= 9007199254740991;
    };
  }
  if (!String.prototype.includes) {
    String.prototype.includes = function(v) { return this.indexOf(v) >= 0; };
  }
  if (!String.prototype.startsWith) {
    String.prototype.startsWith = function(v) { return this.slice(0, v.length) === v; };
  }
  if (!String.prototype.endsWith) {
    String.prototype.endsWith = function(v) { return this.slice(-v.length) === v; };
  }

  // 6. Element matches and closest (critical for Smart TV DOM lookups)
  if (typeof Element !== 'undefined') {
    if (!Element.prototype.matches) {
      Element.prototype.matches = Element.prototype.webkitMatchesSelector ||
        Element.prototype.mozMatchesSelector ||
        Element.prototype.msMatchesSelector ||
        Element.prototype.oMatchesSelector ||
        function(s) {
          var matches = (this.document || this.ownerDocument).querySelectorAll(s),
              i = matches.length;
          while (--i >= 0 && matches.item(i) !== this) {}
          return i > -1;
        };
    }
    if (!Element.prototype.closest) {
      Element.prototype.closest = function(s) {
        var el = this;
        do {
          if (el.matches && el.matches(s)) return el;
          el = el.parentElement || el.parentNode;
        } while (el !== null && el.nodeType === 1);
        return null;
      };
    }
  }

  // 7. AbortController
  if (!window.AbortController) {
    window.AbortController = function() {
      var signal = this.signal = {
        aborted: false,
        listeners: [],
        addEventListener: function(e, fn) { if (e === 'abort') this.listeners.push(fn); },
        removeEventListener: function(e, fn) { this.listeners = this.listeners.filter(function(x) { return x !== fn; }); }
      };
      this.abort = function() {
        signal.aborted = true;
        signal.listeners.forEach(function(fn) { fn(); });
      };
    };
  }

  // 8. ResizeObserver
  if (!window.ResizeObserver) {
    window.ResizeObserver = function(fn) {
      this.observe = function(el) {
        try { fn([{ target: el, contentRect: el.getBoundingClientRect() }]); } catch (e) {}
      };
      this.disconnect = function() {};
      this.unobserve = function() {};
    };
  }

  // 9. CustomEvent
  if (typeof window !== 'undefined' && typeof window.CustomEvent !== 'function') {
    window.CustomEvent = function(event, params) {
      params = params || { bubbles: false, cancelable: false, detail: null };
      var evt = document.createEvent('CustomEvent');
      evt.initCustomEvent(event, params.bubbles, params.cancelable, params.detail);
      return evt;
    };
  }

  // 10. (Telemetry eval bridge removed for production security)

  // 11. Lightweight XHR-backed window.fetch polyfill for Tizen 3.0 (Chromium 47 / WebKit 538)
  if (typeof window !== 'undefined' && typeof window.fetch !== 'function') {
    window.fetch = function(input, init) {
      return new Promise(function(resolve, reject) {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input || ''));
        var opts = init || {};
        var xhr = new XMLHttpRequest();
        var method = String(opts.method || 'GET').toUpperCase();
        var finished = false;
        function abortErr() {
          var err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          return err;
        }
        if (opts.signal && opts.signal.aborted) {
          return reject(abortErr());
        }
        try {
          xhr.open(method, url, true);
        } catch (e) {
          return reject(e);
        }
        xhr.responseType = 'arraybuffer';
        var hdrs = opts.headers || {};
        for (var k in hdrs) {
          if (Object.prototype.hasOwnProperty.call(hdrs, k)) {
            if (/^(user-agent|connection|accept-encoding|host|content-length)$/i.test(k)) continue;
            try { xhr.setRequestHeader(k, String(hdrs[k])); } catch (_) {}
          }
        }
        function onAbort() {
          if (finished) return;
          finished = true;
          try { xhr.abort(); } catch (_) {}
          reject(abortErr());
        }
        if (opts.signal && typeof opts.signal.addEventListener === 'function') {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        function decodeUtf8(buf) {
          if (!buf || !buf.byteLength) return '';
          if (typeof TextDecoder === 'function') {
            try { return new TextDecoder('utf-8').decode(new Uint8Array(buf)); } catch (_) {}
          }
          var u8 = new Uint8Array(buf), out = '', i = 0;
          while (i < u8.length) {
            var c = u8[i++];
            if (c < 128) out += String.fromCharCode(c);
            else if (c > 191 && c < 224) out += String.fromCharCode(((c & 31) << 6) | (u8[i++] & 63));
            else out += String.fromCharCode(((c & 15) << 12) | ((u8[i++] & 63) << 6) | (u8[i++] & 63));
          }
          return out;
        }
        function makeHeaders(raw) {
          var map = {};
          String(raw || '').split(/\r?\n/).forEach(function(line) {
            var idx = line.indexOf(':');
            if (idx > 0) map[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          });
          return {
            get: function(n) { return Object.prototype.hasOwnProperty.call(map, String(n || '').toLowerCase()) ? map[String(n || '').toLowerCase()] : null; }
          };
        }
        xhr.onload = function() {
          if (finished) return;
          finished = true;
          var buf = xhr.response || new ArrayBuffer(0);
          var hdrWrap = makeHeaders(xhr.getAllResponseHeaders());
          var st = xhr.status === 0 ? 200 : xhr.status;
          resolve({
            ok: st >= 200 && st < 300,
            status: st,
            statusText: xhr.statusText || '',
            url: url,
            headers: hdrWrap,
            arrayBuffer: function() { return Promise.resolve(buf); },
            text: function() { return Promise.resolve(decodeUtf8(buf)); },
            json: function() {
              try { return Promise.resolve(JSON.parse(decodeUtf8(buf))); } catch (e) { return Promise.reject(e); }
            }
          });
        };
        xhr.onerror = function() {
          if (finished) return;
          finished = true;
          reject(new TypeError('Network request failed'));
        };
        xhr.ontimeout = function() {
          if (finished) return;
          finished = true;
          reject(new TypeError('Network request timed out'));
        };
        try {
          xhr.send(opts.body !== undefined ? opts.body : null);
        } catch (e) {
          if (!finished) { finished = true; reject(e); }
        }
      });
    };
  }

  // 12. Normalize HTMLMediaElement.play() to always return a Promise.
  // Tizen 3.0 (WebKit 538.1) returns `undefined` from play(), so the common
  // `video.play().catch(...)` pattern throws TypeError and aborts the VOD/HEVC
  // append loop after the first segment. Wrap it so every caller can chain
  // .then/.catch regardless of the engine version.
  if (typeof window !== 'undefined' && window.HTMLMediaElement) {
    try {
      var __origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function() {
        try {
          var __r = __origPlay.apply(this, arguments);
          if (__r && typeof __r.then === 'function') return __r;
          return Promise.resolve();
        } catch (__e) {
          return Promise.resolve();
        }
      };
    } catch (_) {}
  }
})();
