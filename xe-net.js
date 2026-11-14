!function (t) {
  "use strict";
  var isNode = "function" == typeof require,
    r = isNode ? require("./xe-env.js") : t.XuperConfig,
    n = isNode ? require("./xe-cipher.js") : t.XuperCrypto,
    relay = isNode ? require("./xe-relay.js") : t.XuperRelay;

  function o(opts) {
    opts = opts || {};
    var sHost = null;
    try {
      sHost = typeof localStorage !== "undefined" && localStorage.getItem("xuper.working_host");
    } catch (_) {}
    this.hosts = opts.hosts || r.PORTAL_HOSTS.slice();
    this.host = sHost && this.hosts.indexOf(sHost) !== -1 ? sHost : (opts.host || this.hosts[0]);
    this.scheme = opts.scheme || "https";
    this.timeout = opts.timeout || 5000;
    this._fetch = opts.fetch || function () {
      if ("function" == typeof fetch) return fetch;
      throw new Error("fetch no disponible");
    }();
    this.debug = !!opts.debug;
    this.headers = Object.assign({}, r.HEADERS, opts.headers || {});
    ["User-Agent", "Connection", "Accept-Encoding", "Host", "Content-Length"].forEach(function (k) {
      delete this.headers[k];
    }, this);
    this.minInterval = null != opts.minInterval ? opts.minInterval : 120;
    this._turn = Promise.resolve();
    this._lastCall = 0;
  }

  function i(t) {
    if (null == t) return null;
    var e = "res" in t ? "res" : "data" in t ? "data" : null;
    if (!e) return t;
    var val = t[e];
    if ("string" == typeof val && /^[0-9a-fA-F]+$/.test(val) && val.length > 16) {
      try { return JSON.parse(n.unwrap(val)); } catch (_) {
        try { return n.unwrap(val); } catch (_) { return val; }
      }
    }
    return val;
  }

  function a(t) {
    return null == t ? null : "err" in t ? String(t.err) : "returnCode" in t ? String(t.returnCode) : "code" in t ? String(t.code) : null;
  }

  o.prototype._wait = function () {
    var self = this;
    var p = self._turn.then(function () {
      var gap = self.minInterval - (Date.now() - self._lastCall);
      if (self._lastCall && gap > 0) {
        return new Promise(function (resolve) { setTimeout(resolve, gap); });
      }
    }).then(function () {
      self._lastCall = Date.now();
    });
    self._turn = p.catch(function () {});
    return p;
  };

  o.prototype._sendOnce = function (endpoint, payloadStr, host, reqHeaders, useRelay, timeoutMs, clockRetried) {
    var self = this;
    var targetUrl = self.scheme + "://" + host + "/api/portalCore/" + endpoint;
    var hdrs = Object.assign({}, self.headers, reqHeaders || {});
    var fetchUrl = targetUrl;
    var fetchOpts = { method: "POST", headers: hdrs, body: payloadStr };

    if (useRelay && relay && relay.relayBase && relay.relayBase()) {
      var wrapped = relay.wrapPortalRequest(targetUrl, fetchOpts, self.device);
      fetchUrl = wrapped.url;
      fetchOpts = wrapped.options;
    }

    var ctrl = "function" == typeof AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, timeoutMs || self.timeout) : null;
    if (ctrl) fetchOpts.signal = ctrl.signal;

    return self._fetch(fetchUrl, fetchOpts).then(function (res) {
      if (relay && relay.syncClockFromHeaders && res && res.headers) {
        relay.syncClockFromHeaders(res.headers);
      }
      if (useRelay && res.status === 403 && !clockRetried && relay && relay.syncClock) {
        return relay.syncClock(self._fetch).then(function () {
          if (timer) clearTimeout(timer);
          return self._sendOnce(endpoint, payloadStr, host, reqHeaders, true, timeoutMs, true);
        });
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    }).then(function (txt) {
      if (timer) clearTimeout(timer);
      var parsed;
      try { parsed = JSON.parse(txt); } catch (_) {
        throw new Error("El portal devolvió una respuesta no válida");
      }
      if (!parsed || "object" != typeof parsed || Array.isArray(parsed)) {
        throw new Error("Respuesta de portal no válida");
      }
      var code = a(parsed);
      if (null === code) throw new Error("Respuesta de portal sin estado");
      var bodyData = i(parsed);
      if ("0" !== code) {
        var pe = new Error("El servidor rechazó " + endpoint + " (código " + code + ")");
        pe.code = code;
        pe.portalError = true;
        throw pe;
      }
      self.host = host;
      try { typeof localStorage !== "undefined" && localStorage.setItem("xuper.working_host", host); } catch (_) {}
      if (!useRelay && "v8/active" === endpoint && bodyData && bodyData.userId && bodyData.userToken && self.device && relay && relay.donateSession) {
        setTimeout(function () {
          try {
            var snap = {
              sn: self.device.sn,
              snToken: self.device.snToken || "",
              userId: bodyData.userId,
              userToken: bodyData.userToken
            };
            relay.donateSession(self._fetch, snap);
          } catch (_) {}
        }, 500);
      }
      self.debug && console.log("[api]", endpoint, "code=" + code, useRelay ? "(relay)" : "(direct)");
      return { code: code, data: bodyData, envelope: parsed };
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  };

  o.prototype.call = function (endpoint, payload, opts) {
    var self = this;
    opts = opts || {};
    var bodyStr = n.wrap(JSON.stringify(payload));
    var hosts = [self.host].concat(self.hosts.filter(function (h) { return h !== self.host; }));
    var hasRelay = !!(relay && relay.relayBase && relay.relayBase());
    var isActivation = ("v8/active" === endpoint || "v8/login" === endpoint);

    function runMode(useRelay, limitHosts, overrideTimeout) {
      var idx = 0;
      var list = limitHosts ? hosts.slice(0, limitHosts) : hosts;
      var tout = overrideTimeout || ((!useRelay && isActivation) ? 2500 : self.timeout);
      function nextHost() {
        if (idx >= list.length) {
          return Promise.reject(new Error("todos los hosts fallaron para " + endpoint));
        }
        var h = list[idx++];
        return self._sendOnce(endpoint, bodyStr, h, opts.headers, useRelay, tout, false).catch(function (err) {
          if (err && err.portalError) throw err;
          self.debug && console.log("[api] host", h, useRelay ? "(relay)" : "(direct)", "fallo:", err.message);
          return nextHost();
        });
      }
      return nextHost();
    }

    return self._wait().then(function () {
      var portalAlreadyBlocked = !!(hasRelay && relay.isPortalBlocked && relay.isPortalBlocked());
      var chain;

      // ACTIVACIÓN: siempre intentar primero desde la IP del usuario (directo),
      // igual que hace la APK. El Worker de CF suele devolver portal100024.
      if (isActivation) {
        self.debug && console.log("[xe-net] Activación en modo DIRECTO (IP del usuario)...");
        chain = runMode(false, 0, 8000).catch(function (directErr) {
          self.debug && console.warn("[xe-net] Activación directa falló (" + (directErr && directErr.message) + "). Intentando Worker como último recurso...");
          // NO marcamos portalBlocked aquí: el fallo de activación no debe
          // forzar todo el tráfico por el Worker.
          if (hasRelay) {
            return runMode(true, 0, 8000).catch(function () {
              // Último recurso: pool de sesiones del Worker
              if ("v8/active" === endpoint && relay && relay.fetchFallbackSession) {
                self.debug && console.warn("[xe-net] Consultando pool de sesiones...");
                return relay.fetchFallbackSession(self._fetch, self.device).then(function (pooled) {
                  if (!pooled) throw directErr;
                  if (self.device) {
                    if (pooled.sn) {
                      self.device.sn = pooled.sn;
                      if (self.device.store) {
                        self.device.store.set("xuper.sn", pooled.sn);
                        self.device.store.set("xuper.registeredSn", "1");
                      }
                    }
                    if (pooled.snToken && typeof self.device.setSnToken === "function") {
                      self.device.setSnToken(pooled.snToken);
                    }
                  }
                  self.debug && console.log("[api]", endpoint, "code=0 (kv-pool)");
                  return {
                    code: "0",
                    data: { userId: pooled.userId, userToken: pooled.userToken, fromPool: true },
                    envelope: { returnCode: "0" }
                  };
                });
              }
              throw directErr;
            });
          }
          throw directErr;
        });
      } else if (!hasRelay) {
        chain = runMode(false);
      } else if (portalAlreadyBlocked) {
        chain = runMode(true);
      } else {
        // Resto de endpoints: directo primero, Worker si falla
        chain = runMode(false, 2, 3500).catch(function (directErr) {
          self.debug && console.warn("[xe-net] Ruta directa fallida en " + endpoint + " (" + directErr.message + "), usando Worker...");
          if (relay && relay.markPortalBlocked) relay.markPortalBlocked();
          return runMode(true);
        });
      }

      return chain.catch(function (tErr) {
        if (tErr && tErr.portalError) {
          var cStr = String(tErr.code || tErr.message || "");
          var isExp = /^(aaa10002[78]|aaa10000[123]|aaa10008[0-9]|aaa10009[0-9]|10002[78]|10008[0-9]|401|403)$/i.test(String(tErr.code || "")) ||
            /aaa10002[78]|aaa10000[123]|aaa10008[0-9]|aaa10009[0-9]|token|session|auth/i.test(cStr);
          if (isExp && self.onSessionExpired && !opts._isSessionRetry && "v3/snToken" !== endpoint && "v8/active" !== endpoint) {
            console.warn("[xe-net] Renovando sesión automáticamente (" + tErr.code + ") en " + endpoint);
            opts._isSessionRetry = true;
            return self.onSessionExpired().then(function () {
              if (payload && self.device) {
                if ("userId" in payload) payload.userId = self.device.userId;
                if ("userToken" in payload) payload.userToken = self.device.userToken;
              }
              return self.call(endpoint, payload, opts);
            });
          }
          throw tErr;
        }
        try { typeof localStorage !== "undefined" && localStorage.removeItem("xuper.working_host"); } catch (_) {}
        self.host = self.hosts[0];
        throw tErr;
      });
    });
  };

  var s = { Api: o, extractPayload: i, envelopeCode: a };
  t.XuperApi = s;
  "undefined" != typeof module && module.exports && (module.exports = s);
}("undefined" != typeof globalThis ? globalThis : this);
