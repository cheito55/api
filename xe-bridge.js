/**
 * Xuper Eclectic - Tizen Bridge
 * Proporciona autoescalado universal (1366x768 hasta 4K),
 * mapeo de teclas de control remoto Tizen y puente directo con CactusDirect
 * con fallbacks locales pre-empaquetados para máxima resiliencia.
 */
(function (w, d) {
  'use strict';
  var channelCache = Object.create(null);

  function proxyImg(u) {
    if (!u || !w.XuperRelay || !w.XuperRelay.imageUrl) return u;
    if (w.XuperRelay.isImgHostBlocked && w.XuperRelay.isImgHostBlocked(u)) {
      return w.XuperRelay.imageUrl(u);
    }
    return u;
  }

  // Fallback automático por imagen: solo usa /img del Worker si la carga directa falla (ISP bloqueado)
  d.addEventListener('error', function (ev) {
    var img = ev && ev.target;
    if (!img || img.tagName !== 'IMG') return;
    var src = img.getAttribute('src') || img.src || '';
    if (!/^https?:\/\//i.test(src)) return;
    if (img.getAttribute('data-xe-relay') === '1') return;
    if (w.XuperRelay && w.XuperRelay.relayBase && w.XuperRelay.relayBase() && w.XuperRelay.imageUrl) {
      if (src.indexOf(w.XuperRelay.relayBase()) === 0) return;
      if (w.XuperRelay.markImgHostBlocked) w.XuperRelay.markImgHostBlocked(src);
      img.setAttribute('data-xe-relay', '1');
      img.src = w.XuperRelay.imageUrl(src);
    }
  }, true);

  function proxyItemImages(it) {
    if (!it || typeof it !== 'object') return it;
    if (it.poster) it.poster = proxyImg(it.poster);
    if (it.landscape) it.landscape = proxyImg(it.landscape);
    if (it.backdrop) it.backdrop = proxyImg(it.backdrop);
    if (it.cover) it.cover = proxyImg(it.cover);
    if (it.logo) it.logo = proxyImg(it.logo);
    return it;
  }

  // 1. Auto-escalador de resolución universal (1366x768, 720p, 1080p, 4K)
  function fitResolution() {
    try {
      var sw = w.innerWidth || (d.documentElement && d.documentElement.clientWidth) || 1920;
      var sh = w.innerHeight || (d.documentElement && d.documentElement.clientHeight) || 1080;
      var app = d.getElementById('app');
      if (!app) return;

      if (sw !== 1920 || sh !== 1080) {
        var scaleX = sw / 1920;
        var scaleY = sh / 1080;
        var scale = Math.min(scaleX, scaleY);
        app.style.transform = 'scale(' + scale + ')';
        app.style.transformOrigin = '0 0';
        app.style.position = 'absolute';
        app.style.left = Math.max(0, (sw - 1920 * scale) / 2) + 'px';
        app.style.top = Math.max(0, (sh - 1080 * scale) / 2) + 'px';
      } else {
        app.style.transform = '';
        app.style.position = 'relative';
        app.style.left = '0px';
        app.style.top = '0px';
      }
    } catch (e) {
      console.warn('[fitResolution err]', e);
    }
  }

  w.addEventListener('resize', fitResolution);
  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', fitResolution);
  } else {
    fitResolution();
  }

  // 2. Registro de teclas de control remoto Samsung Tizen
  function registerTizenKeys() {
    try {
      if (w.tizen && w.tizen.tvinputdevice) {
        var keys = [
          'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaFastForward',
          'MediaRewind', 'MediaStop', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
        ];
        for (var i = 0; i < keys.length; i++) {
          try {
            w.tizen.tvinputdevice.registerKey(keys[i]);
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  registerTizenKeys();

  // 3. Limpieza de localStorage anterior para evitar bloqueos de flash/CPU
  try {
    ['xuper.cached_channels', 'xuper.cached_home_featured', 'xuper.cached_home_movies', 'xuper.cached_home_series', 'xuper.cached_home_anime', 'xuper.cached_home_kids', 'xuper.cached_home_free', 'xuper_Fatal_Errors'].forEach(function(k) {
      w.localStorage.removeItem(k);
    });
  } catch (e) {}

  // Memoria RAM exclusivamente para caché temporal con control de expiración (TTL)
  var CHANNEL_CACHE_TTL = 20 * 60 * 1000;
  var channelCacheTs = 0;
  var masterRefreshInflight = null;
  var homeCache = {};
  var itemAudioCache = {};
  var itemAudioKeys = [];
  var itemSubtitleCache = {};
  var liveChannelsCache = {};
  var liveChannelsCacheTs = {};
  var lastActiveTs = Date.now();

  function isLicenseValid(list) {
    if (!Array.isArray(list) || !list.length || !list[0] || !list[0].license) return false;
    var m = /[?&]expired=(\d+)/.exec(String(list[0].license));
    if (!m) return true;
    var expSec = Number(m[1]);
    if (!expSec) return true;
    return (expSec * 1000) > (Date.now() + 300000);
  }

  function clearAllCaches(includeSessionCheck) {
    channelCache = Object.create(null);
    channelCacheTs = 0;
    masterRefreshInflight = null;
    homeCache = {};
    itemAudioCache = {};
    itemAudioKeys = [];
    itemSubtitleCache = {};
    liveChannelsCache = {};
    liveChannelsCacheTs = {};
    if (w.CactusDirect && w.CactusDirect.connect) {
      w.CactusDirect.connect().then(function(c) {
        if (c && c.catalog && c.catalog.clearCache) c.catalog.clearCache();
        if (c && c.stream) c.stream._slbCache = null;
        if (includeSessionCheck && c && c.session) {
          c.session.ensure();
        }
      }).catch(function(){});
    }
  }

  function onAppWakecheck() {
    var now = Date.now();
    if (now - lastActiveTs > 30 * 60 * 1000) {
      clearAllCaches(true);
    }
    lastActiveTs = now;
  }

  d.addEventListener('visibilitychange', function() {
    if (!d.hidden) onAppWakecheck();
  });
  w.addEventListener('focus', onAppWakecheck);
  function getBundledHome(root) {
    try {
      var portal = w.XUPERTV_PORTAL || {};
      var rawItems = portal.items || [];
      if (!rawItems.length) {
        rawItems = portal[root] || [];
      }
      if (!rawItems.length) return [];
      var items = rawItems.filter(function(it) {
        return it && !/er[oó]tic|hentai|18\+/i.test(it.title || '');
      });
      items.forEach(proxyItemImages);
      if (root === 'movies' || root === 'pelicula') {
        var m = items.filter(function(it){ return it.kind === 'película' || it.type === 'movie' || (it.category && it.category.indexOf('pelicula') !== -1); });
        return m.length ? m : items;
      }
      if (root === 'series' || root === 'serie') {
        var s = items.filter(function(it){ return it.kind === 'serie' || it.type === 'teleplay' || (it.category && it.category.indexOf('serie') !== -1); });
        return s.length ? s : items;
      }
      if (root === 'anime') {
        var a = items.filter(function(it){ return it.category && it.category.indexOf('anime') !== -1; });
        return a.length ? a : items;
      }
      if (root === 'kids' || root === 'infantil') {
        var k = items.filter(function(it){ return it.category && it.category.indexOf('infantil') !== -1; });
        return k.length ? k : items;
      }
      return items;
    } catch (e) {
      return [];
    }
  }

  function getBundledDetail(contentId) {
    try {
      var portal = w.XUPERTV_PORTAL || {};
      var items = portal.items || [];
      var found = null;
      for (var i = 0; i < items.length; i++) {
        if (String(items[i].id) === String(contentId)) { found = items[i]; break; }
      }
      if (!found && items.length) found = items[0];
      if (!found) return null;
      var isSeries = found.type === 'teleplay' || found.kind === 'serie';
      var episodes = [];
      var seasons = [];
      if (isSeries) {
        seasons = [{ id: String(found.id), number: 1 }];
        for (var ep = 1; ep <= 12; ep++) {
          episodes.push({
            id: String(found.id) + '_' + ep,
            title: 'Capítulo ' + ep,
            name: 'Capítulo ' + ep,
            number: ep,
            duration: '45:00',
            quality: 'HD',
            description: found.synopsis || ''
          });
        }
      }
      return {
        item: {
          id: String(found.id),
          title: found.title || found.name || '',
          score: found.score || '—',
          year: found.year || '—',
          duration: found.duration || '01:45:00',
          genres: found.genres || [],
          director: found.director || '',
          actors: found.actors || '',
          synopsis: found.synopsis || '',
          poster: proxyImg(found.poster || found.landscape),
          landscape: proxyImg(found.landscape || found.poster),
          backdrop: proxyImg(found.backdrop || found.landscape || found.poster),
          type: isSeries ? 'teleplay' : 'movie',
          alias: found.alias || '',
          country: found.country || '',
          releaseDate: found.releaseDate || found.year || '',
          audio: found.audio || (/bra[sz]il|portug/i.test((found.country || '') + ' ' + (found.title || '')) ? 'Portugués' : ''),
          portal: true
        },
        episodes: episodes,
        seasons: seasons
      };
    } catch(e) {
      return null;
    }
  }

  var isAdultChannel = function(c) {
    if (!c) return false;
    var s = ((c.name || '') + ' ' + (c.channelCode || '')).toLowerCase();
    if (s.indexOf('adult swim') !== -1) return false;
    return /18\+|\+18|xxx|playboy|venus|hustler|sextreme|penthouse|redlight|brazzers|dorcel|tokyo hot|heyzo|carib|1pon|nyokei|cr_sexy/i.test(s);
  };

  function refreshMasterChannelCache(client, force) {
    if (!client || !client.live) return Promise.resolve([]);
    var now = Date.now();
    if (!force && channelCacheTs > 0 && (now - channelCacheTs) < CHANNEL_CACHE_TTL && liveChannelsCache[76182] && liveChannelsCache[76182].length) {
      return Promise.resolve(liveChannelsCache[76182]);
    }
    if (masterRefreshInflight) return masterRefreshInflight;
    masterRefreshInflight = client.live.getLiveData({ columnId: 76182, pageSize: 3000 }).then(function (res) {
      masterRefreshInflight = null;
      var list = res && res.channelList || [];
      var chs = [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || isAdultChannel(c) || !Array.isArray(c.liveAddressList) || !c.liveAddressList.length) continue;
        channelCache[c.channelCode] = c;
        chs.push({
          channelCode: c.channelCode,
          index: c.channelNumber || (chs.length + 1),
          name: c.name,
          logo: proxyImg(c.posterUrl || (c.posterList && c.posterList[0] && c.posterList[0].fileUrl) || ''),
          uhd: /fhd|uhd|4k/i.test(c.name || ''),
          fav: false,
          now: 'En vivo',
          next: '',
          time: '',
          liveAddressList: c.liveAddressList
        });
      }
      if (chs.length > 0) {
        if (w.__ESPN_CHANNELS && w.__ESPN_CHANNELS.length) {
          for (var eIdx = 0; eIdx < w.__ESPN_CHANNELS.length; eIdx++) {
            var ech = w.__ESPN_CHANNELS[eIdx];
            var exists = false;
            for (var cIdx = 0; cIdx < chs.length; cIdx++) {
              if (chs[cIdx].channelCode === ech.channelCode) { exists = true; break; }
            }
            if (!exists) {
              chs.push(ech);
            }
          }
        }
        liveChannelsCache[76182] = chs;
        liveChannelsCacheTs[76182] = Date.now();
        channelCacheTs = Date.now();
      }
      return chs;
    }).catch(function (err) {
      masterRefreshInflight = null;
      throw err;
    });
    return masterRefreshInflight;
  }

  function getBundledChannels() {
    if (w.__BUNDLED_CHANNELS && w.__BUNDLED_CHANNELS.length > 0) {
      if (!w.__BUNDLED_FILTERED) {
        w.__BUNDLED_FILTERED = w.__BUNDLED_CHANNELS.filter(function(c) {
          return !isAdultChannel(c);
        });
        w.__BUNDLED_FILTERED.forEach(proxyItemImages);
      }
      return w.__BUNDLED_FILTERED;
    }
    var names = [
      "Canal de Películas HD", "Acción & Cine", "Series Estelares",
      "Deportes en Vivo", "Kids Animación", "Cine Clásico",
      "Mundo Documental", "Música & Hits", "Noticias 24h",
      "Comedia Internacional", "Anime Total", "Canal Familia"
    ];
    var chs = [];
    for (var i = 0; i < names.length; i++) {
      chs.push({
        channelCode: "ch_" + (i + 1),
        index: i + 1,
        name: names[i],
        logo: "",
        uhd: i % 2 === 0,
        fav: i < 3,
        now: "Transmisión en directo",
        next: "Programación habitual",
        time: "En emisión",
        liveAddressList: []
      });
    }
    return chs;
  }

  try {
    var initChs = getBundledChannels();
    if (initChs && initChs.length) {
      liveChannelsCache[76182] = initChs;
      liveChannelsCacheTs[76182] = Date.now();
      channelCacheTs = Date.now();
      for (var ci = 0; ci < initChs.length; ci++) {
        if (initChs[ci] && initChs[ci].channelCode) {
          channelCache[initChs[ci].channelCode] = initChs[ci];
        }
      }
    }
  } catch(e) {}

  // 4. Puente de servicios: Reemplaza las llamadas de webOS Luna service por CactusDirect nativo
  function serviceCall(method, params, callback) {
    params = params || {};
    callback = callback || function () {};

    if (method === 'ping' || method === 'keepAlive' || method === 'heartbeat') {
      return setTimeout(function () {
        callback(null, { returnValue: true, alive: true });
      }, 0);
    }

    if (method === 'mediaInfo') {
      var cid = String(params.contentId || '');
      var cachedAudio = itemAudioCache[cid] || '';
      var cachedSubs = itemSubtitleCache[cid] || [];
      if (!cachedAudio || !cachedSubs.length) {
        var bd = getBundledDetail(cid);
        if (bd && bd.item) {
          if (!cachedAudio && bd.item.audio) cachedAudio = bd.item.audio;
          if (!cachedSubs.length && bd.item.subtitles && bd.item.subtitles.length) cachedSubs = bd.item.subtitles;
        }
      }
      return setTimeout(function() {
        callback(null, {
          returnValue: true,
          name: params.title || '',
          audio: cachedAudio || '',
          subtitles: cachedSubs || [],
          tracks: [],
          duration: 0
        });
      }, 0);
    }

    if (method === 'netdiag') {
      return setTimeout(function() {
        callback(null, {
          returnValue: true,
          hosts: [
            { host: 'api.portal.magis', doh: { ok: true, ips: ['127.0.0.1'] }, system: { ok: true, ips: ['127.0.0.1'] } }
          ],
          layers: { portal: true, session: true, stream: true },
          version: '2.0.5'
        });
      }, 0);
    }

    if (method === 'home') {
      var rootCheck = params.root || 'movies';
      if (homeCache[rootCheck] && homeCache[rootCheck].length > 0) {
        return setTimeout(function () {
          callback(null, { returnValue: true, root: rootCheck, items: homeCache[rootCheck] });
        }, 0);
      }
      if (rootCheck === 'free') {
        var freeBundled = getBundledHome('free');
        homeCache['free'] = freeBundled;
        return setTimeout(function () {
          callback(null, { returnValue: true, root: 'free', items: freeBundled });
        }, 0);
      }
    }

    try {
      if (!w.CactusDirect || !w.CactusDirect.connect) {
        // Fallbacks automáticos sin arrojar excepción
        if (method === 'home') {
          var rFallback = params.root || 'movies';
          return callback(null, { returnValue: true, root: rFallback, items: getBundledHome(rFallback) });
        }
        if (method === 'detail') {
          var bd = getBundledDetail(params.contentId);
          if (bd) return callback(null, { returnValue: true, item: bd.item, episodes: bd.episodes, seasons: bd.seasons });
        }
        if (method === 'liveChannels') {
          return callback(null, { returnValue: true, channels: getBundledChannels() });
        }
        if (method === 'liveCategories') {
          return callback(null, { returnValue: true, categories: [{ id: 76182, name: 'Todos' }, { id: 'favorites', name: '⭐ Favoritos', isFavorite: true }, { id: 'espn', name: 'ESPN', isEspn: true }, { id: 76206, name: 'Deportes' }, { id: 76205, name: 'Cine y Series' }] });
        }
        return setTimeout(function () {
          callback(new Error('CactusDirect no disponible'), { returnValue: false });
        }, 0);
      }

      w.CactusDirect.connect().then(function (client) {

        function getPosterUrl(node) {
          if (!node) return '';
          var list = node.posterList || [];
          for (var j = 0; j < list.length; j++) {
            if (list[j] && list[j].fileType === 'icon' && list[j].fileUrl) return proxyImg(list[j].fileUrl);
          }
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].fileType === 'poster' && list[i].fileUrl) return proxyImg(list[i].fileUrl);
          }
          for (var k = 0; k < list.length; k++) {
            if (list[k] && list[k].fileUrl) return proxyImg(list[k].fileUrl);
          }
          return proxyImg(node.posterUrl || node.poster || node.fileUrl || node.cover || node.imageUrl || node.landscape || '');
        }

        function getBackdropUrl(node) {
          if (!node) return '';
          var list = node.posterList || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].fileType === 'poster' && list[i].fileUrl) return proxyImg(list[i].fileUrl);
          }
          for (var j = 0; j < list.length; j++) {
            if (list[j] && list[j].fileType === 'stage' && list[j].fileUrl) return proxyImg(list[j].fileUrl);
          }
          return proxyImg(node.backdrop || node.landscape || '');
        }

        if (method === 'home') {
          var rootName = params.root || 'movies';
          var fetchShelf = function(colId, pgSize) {
            if (!client || !client.api || !client.catalog || !w.XuperConfig) return Promise.resolve([]);
            return client.api.call(w.XuperConfig.EP.getShelveData, client.catalog._base({
              columnId: colId,
              columnType: '2',
              pageNum: 1,
              pageSize: pgSize || 40,
              encryptVersion: 0
            })).then(function(r) {
              return (r && r.data && r.data.assetList) || [];
            }).catch(function() { return []; });
          };
          var mapServerNode = function(a, catTag, forceKind) {
            if (!a || !(a.contentId || a.id)) return null;
            var titleStr = a.name || a.title || '';
            if (/er[oó]tic|hentai|18\+/i.test(titleStr)) return null;
            var isSer = forceKind === 'serie' || a.programType === 'teleplay' || a.programType === 'series' || String(a.type) === '0' || (a.volumnCount && parseInt(a.volumnCount, 10) > 1);
            var pUrl = getPosterUrl(a);
            if (!pUrl) return null;
            var bUrl = getBackdropUrl(a) || pUrl;
            var rel = String(a.releaseTime || a.releaseDate || '');
            var yr = rel.slice(0, 4) || (a.year ? String(a.year) : '2026');
            var gArr = a.tags ? (typeof a.tags === 'string' ? a.tags.split(',') : a.tags) : (a.genres || []);
            return {
              id: String(a.contentId || a.id),
              contentId: String(a.contentId || a.id),
              rawType: isSer ? '0' : '1',
              type: isSer ? 'teleplay' : 'movie',
              programType: isSer ? 'teleplay' : 'movie',
              title: titleStr,
              alias: a.alias || '',
              category: catTag,
              score: a.score != null ? String(a.score) : '8.0',
              year: yr,
              releaseDate: rel,
              shelveTime: a.shelveTime || a.updateTime || '',
              duration: a.duration || '',
              genres: gArr,
              director: a.director || '—',
              actors: a.actorDisplay || a.actors || '—',
              synopsis: a.description || a.synopsis || 'Sin sinopsis disponible.',
              kind: isSer ? 'serie' : 'película',
              poster: pUrl,
              landscape: bUrl,
              backdrop: bUrl,
              country: a.originalCountry || a.country || '',
              volumeCount: parseInt(a.volumnCount || a.volumeCount, 10) || 0,
              updateCount: parseInt(a.updateCount, 10) || 0,
              portal: true,
              _portal: true
            };
          };

          var homePromise;
          if (rootName === 'movies' || rootName === 'pelicula') {
            homePromise = Promise.all([fetchShelf(76264, 45), fetchShelf(76263, 45), fetchShelf(79105, 35)]).then(function(lists) {
              var raw = [].concat(lists[0] || [], lists[1] || [], lists[2] || []);
              var out = [];
              for (var i = 0; i < raw.length; i++) {
                var m = mapServerNode(raw[i], 'pelicula', 'película');
                if (m) out.push(m);
              }
              return out;
            });
          } else if (rootName === 'series' || rootName === 'serie') {
            homePromise = Promise.all([fetchShelf(76237, 45), fetchShelf(76235, 45)]).then(function(lists) {
              var raw = [].concat(lists[0] || [], lists[1] || []);
              var out = [];
              for (var i = 0; i < raw.length; i++) {
                var s = mapServerNode(raw[i], 'serie', 'serie');
                if (s) out.push(s);
              }
              return out;
            });
          } else if (rootName === 'featured' || rootName === 'destacado') {
            homePromise = Promise.all([
              fetchShelf(79105, 30),
              fetchShelf(76264, 20),
              fetchShelf(76237, 20),
              client.catalog.getNextColumns('masnew_featured', 1, 15).catch(function(){ return null; })
            ]).then(function(resArr) {
              var raw = [].concat(resArr[0] || [], resArr[1] || [], resArr[2] || []);
              var fCols = (resArr[3] && resArr[3].recommendList) || [];
              for (var c = 0; c < fCols.length; c++) {
                if (fCols[c] && !/tr[aá]iler/i.test(fCols[c].name || '') && fCols[c].assetList) {
                  raw = raw.concat(fCols[c].assetList);
                }
              }
              var out = [];
              for (var i = 0; i < raw.length; i++) {
                var f = mapServerNode(raw[i], 'destacado', null);
                if (f) out.push(f);
              }
              return out;
            });
          } else if (rootName === 'anime') {
            homePromise = Promise.all([fetchShelf(76210, 40), fetchShelf(76209, 40)]).then(function(lists) {
              var raw = [].concat(lists[0] || [], lists[1] || []);
              var out = [];
              for (var i = 0; i < raw.length; i++) {
                var an = mapServerNode(raw[i], 'anime', null);
                if (an) out.push(an);
              }
              return out;
            });
          } else if (rootName === 'kids' || rootName === 'infantil') {
            homePromise = Promise.all([
              client.catalog.getNextColumns('masnew_kids', 1, 20).catch(function(){ return null; }),
              fetchShelf(76794, 40)
            ]).then(function(resArr) {
              var raw = [];
              var kCols = (resArr[0] && resArr[0].recommendList) || [];
              for (var c = 0; c < kCols.length; c++) {
                if (kCols[c] && kCols[c].assetList) raw = raw.concat(kCols[c].assetList);
              }
              raw = raw.concat(resArr[1] || []);
              var out = [];
              for (var i = 0; i < raw.length; i++) {
                var kd = mapServerNode(raw[i], 'infantil', null);
                if (kd) out.push(kd);
              }
              return out;
            });
          } else {
            homePromise = Promise.resolve([]);
          }

          var homeTimeout = new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error('home live timeout')); }, 5000);
          });

          return Promise.race([homePromise, homeTimeout]).then(function(liveItems) {
            var localFallback = getBundledHome(rootName);
            var seen = {}, merged = [];
            for (var i = 0; i < liveItems.length; i++) {
              var lid = String(liveItems[i].id);
              if (!seen[lid]) {
                seen[lid] = true;
                merged.push(liveItems[i]);
              }
            }
            for (var j = 0; j < localFallback.length; j++) {
              var bid = String(localFallback[j].id);
              if (!seen[bid]) {
                seen[bid] = true;
                merged.push(localFallback[j]);
              }
            }
            homeCache[rootName] = merged;
            return callback(null, { returnValue: true, root: rootName, items: merged });
          }).catch(function(err) {
            console.warn('[home live fetch fallback]', rootName, err && err.message);
            var fallback = getBundledHome(rootName);
            return callback(null, { returnValue: true, root: rootName, items: fallback });
          });
        }

        if (method === 'detail') {
          var contentId = params.contentId;
          var reqType = String(params.type != null ? params.type : (params.isSeries ? '0' : (params.rawType != null ? params.rawType : '0')));
          var tryGetDetail = function(t) {
            return client.catalog.getItemData(contentId, t);
          };
          return tryGetDetail(reqType).catch(function () {
            var altType = (reqType === '0') ? '1' : '0';
            return tryGetDetail(altType);
          }).then(function (data) {
            var item = null;
            var episodes = [];
            var seasons = [];
            if (data && data.assetData) {
              var a = data.assetData;
              var pType = String(a.programType || a.type || a.contentType || '').toLowerCase();
              var isMovie = (pType === 'movie' || pType === 'pelicula' || pType === 'película' || pType === '1');
              var isSeries = !isMovie && (pType === 'teleplay' || pType === 'series' || pType === '0' || (a.volumnCount && parseInt(a.volumnCount, 10) > 1) || (a.volumeCount && parseInt(a.volumeCount, 10) > 1) || (a.sameSeasonSeriesList && a.sameSeasonSeriesList.length > 1) || (a.simpleProgramList && a.simpleProgramList.length > 1));
              var posterUrl = getPosterUrl(a);
              var backdropUrl = getBackdropUrl(a) || posterUrl;
              var audioStr = a.audio || a.audioInfo || a.language || a.languages || a.dubLanguage || a.voiceLanguage || '';
              if (!audioStr && (a.movieList || a.simpleProgramList)) {
                var mList = a.movieList || a.simpleProgramList;
                for (var mi = 0; mi < mList.length; mi++) {
                  if (mList[mi] && (mList[mi].audio || mList[mi].audioInfo)) {
                    audioStr = mList[mi].audio || mList[mi].audioInfo;
                    break;
                  }
                }
              }
              if (!audioStr && /bra[sz]il|portug/i.test((a.originalCountry || a.country || '') + ' ' + (a.name || a.title || ''))) {
                audioStr = 'Portugués';
              }
              if (audioStr) {
                itemAudioCache[String(contentId)] = audioStr;
              }
              var extractedSubs = (w.CactusTracks ? w.CactusTracks.collect(a) : (a.subtitles || [])) || [];
              if (extractedSubs.length) {
                itemSubtitleCache[String(contentId)] = extractedSubs;
              }
              item = {
                id: String(a.contentId),
                contentId: String(a.contentId),
                title: a.name || a.title || '',
                score: a.score || '—',
                year: a.releaseTime ? a.releaseTime.slice(0, 4) : '—',
                duration: a.duration || '',
                genres: a.tags ? (typeof a.tags === 'string' ? a.tags.split(',') : a.tags) : (a.genres || []),
                director: a.director || '',
                actors: a.actorDisplay || a.actors || '',
                synopsis: a.description || a.synopsis || '',
                poster: posterUrl,
                landscape: backdropUrl,
                backdrop: backdropUrl,
                type: isSeries ? 'teleplay' : 'movie',
                kind: isSeries ? 'serie' : 'película',
                rawType: isSeries ? '0' : '1',
                alias: a.alias || '',
                country: a.originalCountry || a.country || '',
                releaseDate: a.releaseTime || a.releaseDate || '',
                audio: audioStr || '',
                subtitles: extractedSubs,
                portal: true,
                _portal: true
              };

              if (isSeries) {
                var progList = a.simpleProgramList || a.itemList || [];
                for (var e = 0; e < progList.length; e++) {
                  var ep = progList[e];
                  episodes.push({
                    id: String(ep.contentId || ep.id),
                    title: ep.name || ep.title || ('Capítulo ' + (e + 1)),
                    name: ep.name || ep.title || ('Capítulo ' + (e + 1)),
                    number: ep.seriesNumber || ep.number || (e + 1),
                    duration: ep.duration || '',
                    quality: ep.quality || 'HD',
                    description: ep.description || ep.synopsis || ''
                  });
                }

                var ssList = a.sameSeasonSeriesList || [];
                for (var s = 0; s < ssList.length; s++) {
                  seasons.push({
                    id: String(ssList[s].contentId),
                    number: ssList[s].seasonNumber || (s + 1)
                  });
                }
              }
            }
            callback(null, { returnValue: true, item: item, episodes: episodes, seasons: seasons });
          }).catch(function (err) {
            console.warn('[detail error, using bundled]', err);
            var bd = getBundledDetail(contentId);
            if (bd) return callback(null, { returnValue: true, item: bd.item, episodes: bd.episodes, seasons: bd.seasons });
            callback(err, { returnValue: false, errorText: String(err && err.message || err) });
          });
        }

        if (method === 'search') {
          var query = params.value || '';
          var normBridge = function(s) {
            if (!s) return '';
            try {
              return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ñ/g, 'n').trim();
            } catch(e) { return String(s).toLowerCase().trim(); }
          };
          var stripBridge = function(s) {
            return normBridge(s).replace(/[^a-z0-9]/g, '');
          };
          var scoreBridgeItem = function(it, qNorm, qStrip) {
            var tN = normBridge(it.title || it.name || '');
            var tStrip = stripBridge(it.title || it.name || '');
            var aN = normBridge(it.alias || '');
            var aStrip = stripBridge(it.alias || '');
            var s = 0;
            if (tN === qNorm || (qStrip.length > 1 && tStrip === qStrip)) s += 10000;
            else if (tN.indexOf(qNorm) === 0 || (qStrip.length > 1 && tStrip.indexOf(qStrip) === 0)) s += 5000;
            else if (tN.indexOf(qNorm) !== -1 || (qStrip.length > 1 && tStrip.indexOf(qStrip) !== -1)) s += 2500;
            else if (aN.indexOf(qNorm) !== -1 || (qStrip.length > 1 && aStrip.indexOf(qStrip) !== -1)) s += 1500;
            else {
              var full = tN + ' ' + aN + ' ' + normBridge(it.actors || '') + ' ' + normBridge(it.director || '') + ' ' + normBridge(it.synopsis || '');
              if (full.indexOf(qNorm) !== -1) s += 500;
            }
            if (it._portal || it.portal) s += 300;
            return s;
          };

          var searchLocalPool = function(q) {
            var nq = normBridge(q);
            var sq = stripBridge(q);
            if (!nq && !sq) return [];
            var pool = ((w.XUPERTV_PORTAL && w.XUPERTV_PORTAL.items) || []).concat((w.XUPERTV_CATALOG && w.XUPERTV_CATALOG.items) || []);
            var matches = [], seen = {};
            for (var k = 0; k < pool.length; k++) {
              var it = pool[k];
              if (!it) continue;
              var cid = String(it.id || k);
              var sc = scoreBridgeItem(it, nq, sq);
              if (sc > 0 && !seen[cid]) {
                seen[cid] = true;
                matches.push({ item: it, score: sc });
              }
            }
            matches.sort(function(a, b) { return b.score - a.score; });
            return matches.map(function(m) { return m.item; });
          };

          var extractFromApi = function(obj) {
            var res = [], seenMap = {};
            var walk = function(node) {
              if (!node || typeof node !== 'object') return;
              if (node.contentId || (node.id && (node.title || node.name))) {
                var id = String(node.contentId || node.id);
                if (!seenMap[id]) {
                  seenMap[id] = true;
                  var isSeries = (node.programType === 'teleplay' || node.programType === 'series' || String(node.type) === '0' || (node.volumnCount && parseInt(node.volumnCount, 10) > 1));
                  var pUrl = getPosterUrl(node);
                  var bUrl = getBackdropUrl(node) || pUrl;
                  res.push({
                    id: id,
                    contentId: id,
                    title: node.name || node.title || '',
                    score: node.score || '—',
                    year: node.releaseTime ? String(node.releaseTime).slice(0, 4) : (node.year || '—'),
                    poster: pUrl,
                    landscape: bUrl,
                    backdrop: bUrl,
                    type: isSeries ? 'teleplay' : 'movie',
                    kind: isSeries ? 'serie' : 'película',
                    programType: isSeries ? 'teleplay' : 'movie',
                    rawType: isSeries ? '0' : '1',
                    genres: node.tags ? (typeof node.tags === 'string' ? node.tags.split(',') : node.tags) : (node.genres || []),
                    director: node.director || '',
                    actors: node.actorDisplay || node.actors || '',
                    synopsis: node.description || node.synopsis || node.programUpdateContent || '',
                    portal: true,
                    _portal: true
                  });
                }
                return;
              }
              for (var key in node) {
                if (Object.prototype.hasOwnProperty.call(node, key)) {
                  walk(node[key]);
                }
              }
            }
            walk(obj);
            return res;
          }

          return client.catalog.search(query, 1, 50, '4').then(function (data) {
            var apiItems = extractFromApi(data);
            var qNorm = normBridge(query), qStrip = stripBridge(query);
            var localItems = searchLocalPool(query);
            var seen = {}, merged = [];
            apiItems.sort(function(a, b) {
              return scoreBridgeItem(b, qNorm, qStrip) - scoreBridgeItem(a, qNorm, qStrip);
            });
            for (var a = 0; a < apiItems.length; a++) {
              seen[String(apiItems[a].id)] = true;
              merged.push(apiItems[a]);
            }
            for (var b = 0; b < localItems.length; b++) {
              if (!seen[String(localItems[b].id)]) {
                seen[String(localItems[b].id)] = true;
                merged.push(localItems[b]);
              }
            }
            merged.sort(function(a, b) {
              return scoreBridgeItem(b, qNorm, qStrip) - scoreBridgeItem(a, qNorm, qStrip);
            });
            callback(null, { returnValue: true, items: merged, total: merged.length });
          }).catch(function (err) {
            console.warn('[search API error, using local search pool]', err);
            var localItems = searchLocalPool(query);
            callback(null, { returnValue: true, items: localItems, total: localItems.length });
          });
        }

        if (method === 'liveChannels') {
          var colId = params.columnId || 76182;
          if (colId === 'espn' || colId === 'ESPN') {
            var espnList = (w.__ESPN_CHANNELS && w.__ESPN_CHANNELS.length) ? w.__ESPN_CHANNELS.slice() : [];
            return setTimeout(function() {
              callback(null, { returnValue: true, channels: espnList });
            }, 0);
          }
          if (colId === 'favorites') {
            var favList = [];
            try {
              var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('xuper_favorite_channels') : null;
              var favCodes = raw ? JSON.parse(raw) : [];
              if (Array.isArray(favCodes) && favCodes.length > 0) {
                var pool = (liveChannelsCache[76182] && liveChannelsCache[76182].length) ? liveChannelsCache[76182] : getBundledChannels();
                for (var f = 0; f < pool.length; f++) {
                  var pch = pool[f];
                  if (favCodes.indexOf(pch.channelCode || pch.name) !== -1 || pch.fav) {
                    favList.push(pch);
                  }
                }
              }
            } catch(e) {}
            return setTimeout(function() {
              callback(null, { returnValue: true, channels: favList });
            }, 0);
          }
          if (Number(colId) === 76208) {
            return setTimeout(function() {
              callback(null, { returnValue: true, channels: [] });
            }, 0);
          }
          var nowMs = Date.now();
          if (liveChannelsCache[colId] && liveChannelsCache[colId].length && (nowMs - (liveChannelsCacheTs[colId] || 0)) < CHANNEL_CACHE_TTL) {
            return setTimeout(function() {
              callback(null, { returnValue: true, channels: liveChannelsCache[colId] });
            }, 0);
          }
          if (client && client.live) {
            var timeoutPromise = new Promise(function(_, reject) {
              setTimeout(function() { reject(new Error('liveChannels fetch timeout')); }, 3000);
            });
            return Promise.race([
              client.live.getLiveData({ columnId: colId, pageSize: 3000 }),
              timeoutPromise
            ]).then(function (res) {
              var list = res && res.channelList || [];
              var chs = [];
              for (var i = 0; i < list.length; i++) {
                var c = list[i];
                if (!c || isAdultChannel(c) || !Array.isArray(c.liveAddressList) || !c.liveAddressList.length) continue;
                channelCache[c.channelCode] = c;
                chs.push({
                  channelCode: c.channelCode,
                  index: c.channelNumber || (chs.length + 1),
                  name: c.name,
                  logo: proxyImg(c.posterUrl || (c.posterList && c.posterList[0] && c.posterList[0].fileUrl) || ''),
                  uhd: /fhd|uhd|4k/i.test(c.name || ''),
                  fav: false,
                  now: 'En vivo',
                  next: '',
                  time: '',
                  liveAddressList: c.liveAddressList
                });
              }
              if (chs.length > 0) {
                if ((Number(colId) === 76182 || Number(colId) === 76206) && w.__ESPN_CHANNELS && w.__ESPN_CHANNELS.length) {
                  for (var eIdx = 0; eIdx < w.__ESPN_CHANNELS.length; eIdx++) {
                    var ech = w.__ESPN_CHANNELS[eIdx];
                    var exists = false;
                    for (var cIdx = 0; cIdx < chs.length; cIdx++) {
                      if (chs[cIdx].channelCode === ech.channelCode) { exists = true; break; }
                    }
                    if (!exists) {
                      chs.push(ech);
                    }
                  }
                }
                liveChannelsCache[colId] = chs;
                liveChannelsCacheTs[colId] = Date.now();
                if (Number(colId) === 76182) {
                  channelCacheTs = Date.now();
                }
                return callback(null, { returnValue: true, channels: chs });
              }
              var fallback = (liveChannelsCache[76182] && liveChannelsCache[76182].length) ? liveChannelsCache[76182] : getBundledChannels();
              return callback(null, { returnValue: true, channels: fallback });
            }).catch(function (err) {
              console.warn('[liveChannels category fetch error, using fallback]', err);
              var fallback = (liveChannelsCache[76182] && liveChannelsCache[76182].length) ? liveChannelsCache[76182] : getBundledChannels();
              return callback(null, { returnValue: true, channels: fallback });
            });
          }
          var fallbackChs = (liveChannelsCache[colId] && liveChannelsCache[colId].length) ? liveChannelsCache[colId] : getBundledChannels();
          return setTimeout(function() {
            callback(null, { returnValue: true, channels: fallbackChs });
          }, 0);
        }

        if (method === 'liveCategories') {
          return client.catalog.getNextColumns('masnew_live', 1, 50).then(function (r) {
            var rec = r && r.recommendList || [];
            var categories = [];
            categories.push({ id: 76182, name: 'Todos' });
            categories.push({ id: 'favorites', name: '⭐ Favoritos', isFavorite: true });
            categories.push({ id: 'espn', name: 'ESPN', isEspn: true });
            for (var i = 0; i < rec.length; i++) {
              if (rec[i] && rec[i].columnId) {
                var colId = Number(rec[i].columnId);
                var cName = rec[i].name || rec[i].title || ('Categoría ' + (i + 1));
                if (cName === 'ChannelList' || colId === 76182 || /espn/i.test(cName)) continue;
                if (colId === 76208 || /18\+|adult|xxx/i.test(cName)) continue;
                categories.push({
                  id: rec[i].columnId,
                  name: cName,
                  code: rec[i].code || ''
                });
              }
            }
            callback(null, { returnValue: true, categories: categories });
          }).catch(function (err) {
            console.warn('[liveCategories error, using default]', err);
            callback(null, { returnValue: true, categories: [
              { id: 76182, name: 'Todos' },
              { id: 'favorites', name: '⭐ Favoritos', isFavorite: true },
              { id: 'espn', name: 'ESPN', isEspn: true },
              { id: 76206, name: 'Deportes' },
              { id: 76205, name: 'Cine y Series' },
              { id: 79146, name: 'Infantil' },
              { id: 76188, name: 'Colombia' },
              { id: 76190, name: 'Ecuador' },
              { id: 76207, name: 'Chile' },
              { id: 76197, name: 'México' },
              { id: 76187, name: 'Perú' },
              { id: 76191, name: 'España' },
              { id: 76194, name: 'Estados Unidos' },
              { id: 76193, name: 'Noticias' },
              { id: 76183, name: 'Música' },
              { id: 76196, name: 'Cultura' },
              { id: 76189, name: '24/7' }
            ] });
          });
        }

        if (method === 'filterOptions') {
          var rootCol = (params && (params.root || params.columnCode)) || 'movies';
          return client.catalog.filterOptions(rootCol).then(function (res) {
            callback(null, { returnValue: true, data: res });
          }).catch(function (err) {
            console.warn('[filterOptions error]', err);
            callback(null, { returnValue: false, errorText: String(err && err.message || err) });
          });
        }

        if (method === 'filterContent') {
          var rootCol2 = (params && (params.root || params.columnCode)) || 'movies';
          return client.catalog.filterContent(rootCol2, params || {}).then(function (res) {
            var items = extractFromApi(res);
            callback(null, { returnValue: true, items: items, total: items.length });
          }).catch(function (err) {
            console.warn('[filterContent error]', err);
            callback(null, { returnValue: false, errorText: String(err && err.message || err) });
          });
        }

        if (method === 'resolve' || method === 'resolveSmooth') {
          var isSeries = String(params.type) === '0';
          var sId = params.contentId;
          var item = {
            contentId: sId,
            type: isSeries ? '0' : '1',
            episode: isSeries ? (Number(params.episode) || 1) : 1
          };
          if (isSeries) {
            item.seriesContentId = params.seriesContentId || sId;
            item.columnId = params.columnId || 76178;
          }
          return w.CactusDirect.http('play', [item]).then(function (res) {
            return res.json().then(function (json) {
              var data = json && json.data;
              if (!data) {
                return callback(new Error(json && json.error || 'No se pudo resolver el enlace de reproducción'), { returnValue: false });
              }
              var rSubs = data.subtitles || [];
              if (rSubs.length) {
                itemSubtitleCache[String(sId)] = rSubs;
                if (isSeries && params.seriesContentId) itemSubtitleCache[String(params.seriesContentId)] = rSubs;
              }
              var startPos = params.startTime || params.resume || (w.__resumeStartTime || 0);
              if (data.engine === 'cactus-vod-ts' && w.CactusVODBrowser) {
                w.CactusVODBrowser.start(data, {
                  title: params.title || 'Reproducción',
                  resume: startPos,
                  startTime: startPos,
                  subtitles: data.subtitles || []
                }).then(function() {
                  console.log('[CactusVODBrowser] Started successfully');
                }).catch(function (err) {
                  console.error('[CactusVODBrowser error]', err);
                  var errStr = String(err && err.message || err || '');
                  if (!/cancelad/i.test(errStr) && w.__onStreamError) w.__onStreamError(errStr);
                });
                return callback(null, {
                  returnValue: true,
                  proxyPath: '__cactus_vod__',
                  url: '__cactus_vod__',
                  mime: 'application/vnd.apple.mpegurl',
                  duration: data.duration || 0,
                  subtitles: data.subtitles || [],
                  isHls: true,
                  data: data
                });
              }
              var streamUrl = data.url || '';
              if (w.CactusAVPlay && w.CactusAVPlay.available() && streamUrl) {
                w.CactusAVPlay.start({
                  url: streamUrl,
                  title: params.title || 'Reproducción',
                  kind: 'vod',
                  subtitles: data.subtitles || [],
                  startTime: startPos,
                  resume: startPos
                }).catch(function(err){ console.error('[CactusAVPlay error]', err); });
                return callback(null, {
                  returnValue: true,
                  proxyPath: '__cactus_avplay__',
                  url: '__cactus_avplay__',
                  mime: 'video/mp4',
                  duration: data.duration || 0,
                  subtitles: data.subtitles || []
                });
              }
              callback(null, {
                returnValue: true,
                proxyPath: streamUrl,
                url: streamUrl,
                mime: 'video/mp4',
                duration: data.duration || 0,
                subtitles: data.subtitles || [],
                isHls: streamUrl.indexOf('.m3u8') !== -1,
                data: data
              });
            });
          }).catch(function (err) {
            console.error('[resolve error]', err);
            callback(err, { returnValue: false, errorText: String(err && err.message || err) });
          });
        }

        if (method === 'resolveLive') {
          var directStream = params.streamUrl || params.url || '';
          if (directStream && /^https?:\/\//i.test(directStream)) {
            if (w.CactusAVPlay && w.CactusAVPlay.available()) {
              w.CactusAVPlay.start({
                url: directStream,
                title: params.name || 'Canal en vivo',
                kind: 'live'
              }).then(function(){
                console.log('[AVPlay live direct success]');
              }).catch(function(err){
                console.warn('[AVPlay live direct error, falling back to Hls.js]', err);
                if (typeof w.pn === 'function') {
                  w.pn(directStream);
                }
              });
              return callback(null, { returnValue: true, url: '__cactus_live__', proxyPath: '__cactus_live__', isHls: true });
            }
            return callback(null, { returnValue: true, url: directStream, proxyPath: directStream, isHls: true });
          }
          var tuneWithItem = function(chItem) {
            return w.CactusDirect.http('play', [chItem]).then(function (res) {
              return res.json().then(function (json) {
                var data = json && json.data;
                if (data && data.engine === 'cactus-live-15' && w.CactusAVPlay) {
                  w.CactusAVPlay.start({
                    kind: 'live',
                    engine: 'cactus-live-15',
                    title: chItem.name,
                    item: chItem
                  }).then(function() {
                    console.log('[CactusLiveTV] Playing channel successfully');
                  }).catch(function (err) {
                    console.error('[CactusAVPlay live error]', err);
                    if (w.__onStreamError) w.__onStreamError(String(err && err.message || err));
                  });
                  return callback(null, {
                    returnValue: true,
                    url: '__cactus_live__',
                    proxyPath: '__cactus_live__',
                    isHls: true
                  });
                }
                var directUrl = data && data.url;
                if (directUrl) {
                  if (w.CactusAVPlay && w.CactusAVPlay.available()) {
                    w.CactusAVPlay.start({
                      url: directUrl,
                      title: chItem.name,
                      kind: 'live'
                    }).catch(function(err){ console.error('[AVPlay live]', err); });
                    return callback(null, { returnValue: true, url: '__cactus_live__', proxyPath: '__cactus_live__', isHls: true });
                  }
                  return callback(null, { returnValue: true, url: directUrl, proxyPath: directUrl, isHls: true });
                }
                callback(new Error(json && json.error || 'No se pudo sintonizar el canal'), { returnValue: false });
              });
            });
          }

          var isCacheFresh = channelCacheTs > 0 && (Date.now() - channelCacheTs) < CHANNEL_CACHE_TTL;
          var cached = channelCache[params.channelCode] || {};
          var fastList = (isCacheFresh && isLicenseValid(cached.liveAddressList))
            ? cached.liveAddressList
            : ((params.liveAddressList && params.liveAddressList.length && params.liveAddressList[0].license && isLicenseValid(params.liveAddressList))
                ? params.liveAddressList
                : (isLicenseValid(cached.liveAddressList) ? cached.liveAddressList : null));

          if (fastList && fastList.length && fastList[0].license) {
            return tuneWithItem({
              channelCode: params.channelCode,
              name: params.name || cached.name || 'Canal en vivo',
              liveAddressList: fastList
            }).catch(function (err) {
              console.warn('[resolveLive fastList tune failed, attempting refreshMasterChannelCache]', err);
              return refreshMasterChannelCache(client, true).then(function() {
                var fresh = channelCache[params.channelCode];
                var freshList = (fresh && isLicenseValid(fresh.liveAddressList)) ? fresh.liveAddressList : null;
                if (freshList && freshList.length) {
                  return tuneWithItem({
                    channelCode: params.channelCode,
                    name: params.name || (fresh && fresh.name) || 'Canal en vivo',
                    liveAddressList: freshList
                  });
                }
                throw err;
              }).catch(function (err2) {
                console.error('[resolveLive error]', err2);
                callback(err2, { returnValue: false, errorText: String(err2 && err2.message || err2) });
              });
            });
          }

          return refreshMasterChannelCache(client, !isCacheFresh).then(function () {
            var fresh = channelCache[params.channelCode];
            var fallbackList = (fresh && isLicenseValid(fresh.liveAddressList))
              ? fresh.liveAddressList
              : (isLicenseValid(params.liveAddressList) ? params.liveAddressList : ((fresh && fresh.liveAddressList) || params.liveAddressList || []));
            if (fallbackList && fallbackList.length) {
              return tuneWithItem({
                channelCode: params.channelCode,
                name: params.name || (fresh && fresh.name) || 'Canal en vivo',
                liveAddressList: fallbackList
              });
            }
            throw new Error('Canal sin licencia de emisión disponible');
          }).catch(function (err) {
            var fallback = isLicenseValid(params.liveAddressList) ? params.liveAddressList : (cached.liveAddressList || []);
            if (fallback && fallback.length) {
              return tuneWithItem({
                channelCode: params.channelCode,
                name: params.name || cached.name || 'Canal en vivo',
                liveAddressList: fallback
              }).catch(function (err2) {
                callback(err2, { returnValue: false, errorText: String(err2 && err2.message || err2) });
              });
            }
            console.error('[resolveLive error after refresh]', err);
            callback(err, { returnValue: false, errorText: String(err && err.message || err) });
          });
        }

        callback(new Error('Método desconocido: ' + method), { returnValue: false });
      }).catch(function (err) {
        console.warn('[CactusDirect.connect rejected, using local fallback]', method, err);
        if (method === 'home') {
          return callback(null, { returnValue: true, root: params.root || 'movies', items: getBundledHome(params.root || 'movies') });
        }
        if (method === 'liveChannels') {
          return callback(null, { returnValue: true, channels: getBundledChannels() });
        }
        if (method === 'liveCategories') {
          return callback(null, { returnValue: true, categories: [{ id: 76182, name: 'Todos' }, { id: 'favorites', name: '⭐ Favoritos', isFavorite: true }, { id: 'espn', name: 'ESPN', isEspn: true }, { id: 76206, name: 'Deportes' }, { id: 76205, name: 'Cine y Series' }] });
        }
        callback(err, { returnValue: false, errorText: String(err && err.message || err) });
      });
    } catch (syncErr) {
      console.error('[Tizen Bridge Sync Error]', method, syncErr);
      if (method === 'home') {
        return callback(null, { returnValue: true, root: params.root || 'movies', items: getBundledHome(params.root || 'movies') });
      }
      if (method === 'liveChannels') {
        return callback(null, { returnValue: true, channels: getBundledChannels() });
      }
      if (method === 'liveCategories') {
        return callback(null, { returnValue: true, categories: [{ id: 76182, name: 'Todos' }] });
      }
      callback(syncErr, { returnValue: false, errorText: String(syncErr && syncErr.message || syncErr) });
    }
    return true;
  }

  // Exportar el puente como mock de webOS.service para máxima compatibilidad con el controlador
  w.webOS = w.webOS || {};
  w.webOS.service = {
    request: function (uri, opts) {
      opts = opts || {};
      var method = opts.method;
      var params = opts.parameters;
      serviceCall(method, params, function (err, res) {
        if (err || (res && res.returnValue === false)) {
          if (opts.onFailure) opts.onFailure(err || res);
        } else {
          if (opts.onSuccess) opts.onSuccess(res);
        }
      });
      return { cancel: function () {} };
    }
  };

  w.XuperTizenBridge = {
    call: serviceCall,
    fitResolution: fitResolution,
    clearCaches: function() { clearAllCaches(true); }
  };

})(window, document);
