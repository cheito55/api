import { connect } from "cloudflare:sockets";

/*
 * Xuper portal proxy Worker
 *
 * Required Worker variables:
 *   PROXY_LIST       comma-separated IPs or JSON list of proxy objects
 *   PROXY_PORT_HEX   shared port for IP-only entries, e.g. 0xC38
 *   TARGET_HOST      portal hostname, e.g. ftmrmy.jdfey0cd.com
 * Optional secrets:
 *   PROXY_USERNAME / PROXY_PASSWORD (only for authenticated proxies)
 * Legacy single proxy: PROXY_HOST + PROXY_PORT
 *
 * Optional:
 *   PORTAL_CODE      default "masnew"
 *   SESSIONS         KV namespace binding
 *
 * Configure proxy credentials as Cloudflare Worker Secrets, not in source code.
 */

const PORTAL_CONFIG = {
  portalCode: "masnew",
  appId: "com.android.msandroid",
  apkVersion: "49902",
  // The original Worker used 43404 in the apkVer header.
  // Kept separate because it may intentionally differ from apkVersion.
  apkHeaderVersion: "43404",
  sysVersion: "2024-09-10 06:25:30_33_13_",
  hardwareInfo: "ranchu",
  model: "sdk_gphone64_arm64",
  product: "sdk_gphone64_arm64",
  cpu: "arm64-v8a",
  sdkVer: 33
};

// Sal oficial usada por la app para derivar "sn" a partir de snToken
// (sn = md5(snToken + PORTAL_SALT)) cuando el portal no devuelve uno propio.
const PORTAL_SALT = "ntFT65w6itH!lHCPw7D=@qnsFC5adD28";

const DEFAULT_TARGET_HOST = "ftmrmy.jdfey0cd.com";
const CONNECT_TIMEOUT_MS = 10000;
const RESPONSE_TIMEOUT_MS = 30000;

// ==========================================
// CRIPTOGRAFÍA PURA JS (3DES-ECB + MD5)
// ==========================================
// El portal cifra/descifra el body de snToken y active con 3DES en modo ECB.
// Sin este paso, performAutoActivation mandaba el JSON en texto plano y el
// portal lo rechazaba (o directamente no generaba userId/userToken), aunque
// el túnel de proxies ya funcionara. Portado 1:1 desde worker5.js, que ya
// lo tenía probado contra el mismo backend (portalCore).
const HEX_CHARS = "0123456789abcdef";
const HEX_LUT = new Uint8Array(128);
for (let r = 0; r < 10; r++) HEX_LUT[48 + r] = r;
for (let e = 0; e < 6; e++) { HEX_LUT[97 + e] = 10 + e; HEX_LUT[65 + e] = 10 + e; }

function hexToBytes(hex) {
  const len = hex.length >>> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (HEX_LUT[127 & hex.charCodeAt(2 * i)] << 4) | HEX_LUT[127 & hex.charCodeAt(2 * i + 1)];
  }
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += HEX_CHARS[b >> 4] + HEX_CHARS[15 & b];
  }
  return s;
}

function b64encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(bin);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
  return out;
}

function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

function utf8Decode(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

// Tablas de permutación DES
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const IP_TAB = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const FP_TAB = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const P_TAB = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
];

function permute(r, e) {
  const n = new Array(e.length);
  for (let t = 0; t < e.length; t++) n[t] = r[e[t] - 1];
  return n;
}

function bytesToBits(r) {
  const e = [];
  for (let n = 0; n < r.length; n++) {
    for (let t = 7; t >= 0; t--) e.push((r[n] >> t) & 1);
  }
  return e;
}

function keySchedule(r) {
  const e = permute(bytesToBits(r), PC1);
  const n = e.slice(0, 28);
  const t = e.slice(28, 56);
  const o = [];
  for (let f = 0; f < 16; f++) {
    for (let u = 0; u < SHIFTS[f]; u++) { n.push(n.shift()); t.push(t.shift()); }
    o.push(permute(n.concat(t), PC2));
  }
  return o;
}

const SP = [], IP_L = [], IP_R = [], FP_HI = [], FP_LO = [];
(function initTables() {
  for (let r = 0; r < 8; r++) {
    const e = new Int32Array(64);
    for (let n = 0; n < 64; n++) {
      const t = ((n >>> 5) << 1) | (1 & n);
      const o = (n >>> 1) & 15;
      const f = SBOX[r][16 * t + o];
      let u = 0;
      for (let a = 0; a < 32; a++) {
        const i = P_TAB[a] - 1;
        if ((i >>> 2) === r && ((f >>> (3 - (3 & i))) & 1)) u |= 1 << (31 - a);
      }
      e[n] = u;
    }
    SP.push(e);
  }
  for (let c = 0; c < 8; c++) {
    const l = new Int32Array(256), v = new Int32Array(256);
    for (let y = 0; y < 256; y++) {
      let p = 0, b = 0;
      for (let w = 0; w < 32; w++) {
        const A = IP_TAB[w] - 1;
        if ((A >>> 3) === c && ((y >>> (7 - (7 & A))) & 1)) p |= 1 << (31 - w);
        const m = IP_TAB[32 + w] - 1;
        if ((m >>> 3) === c && ((y >>> (7 - (7 & m))) & 1)) b |= 1 << (31 - w);
      }
      l[y] = p; v[y] = b;
    }
    IP_L.push(l); IP_R.push(v);
  }
  for (let U = 0; U < 8; U++) {
    const C = new Int32Array(256), x = new Int32Array(256);
    for (let S = 0; S < 256; S++) {
      let T = 0, B = 0;
      for (let E = 0; E < 32; E++) {
        const D = FP_TAB[E] - 1;
        if ((D >>> 3) === U && ((S >>> (7 - (7 & D))) & 1)) T |= 1 << (31 - E);
        const _ = FP_TAB[32 + E] - 1;
        if ((_ >>> 3) === U && ((S >>> (7 - (7 & _))) & 1)) B |= 1 << (31 - E);
      }
      C[S] = T; x[S] = B;
    }
    FP_HI.push(C); FP_LO.push(x);
  }
})();

function packKS(r, reverse) {
  const n = new Int32Array(128);
  for (let t = 0; t < 16; t++) {
    const o = r[reverse ? 15 - t : t];
    for (let f = 0; f < 8; f++) {
      let u = 0;
      for (let a = 0; a < 6; a++) u = (u << 1) | o[6 * f + a];
      n[8 * t + f] = u;
    }
  }
  return n;
}

function runFast3DES(r, e, decrypt) {
  const t = packKS(keySchedule(e.slice(0, 8)), decrypt);
  const o = packKS(keySchedule(e.slice(8, 16)), !decrypt);
  const f = packKS(keySchedule(e.slice(16, 24)), decrypt);
  const u = decrypt ? f : t;
  const a = o;
  const i = decrypt ? t : f;
  const c = new Uint8Array(r.length);

  for (let l = 0, h = r.length & -8; l < h; l += 8) {
    const s = r[l], v = r[l + 1], d = r[l + 2], g = r[l + 3], y = r[l + 4], p = r[l + 5], w = r[l + 6], A = r[l + 7];
    let m = IP_L[0][s] | IP_L[1][v] | IP_L[2][d] | IP_L[3][g] | IP_L[4][y] | IP_L[5][p] | IP_L[6][w] | IP_L[7][A];
    let U = IP_R[0][s] | IP_R[1][v] | IP_R[2][d] | IP_R[3][g] | IP_R[4][y] | IP_R[5][p] | IP_R[6][w] | IP_R[7][A];

    for (let C = 0; C < 128; C += 8) {
      const x = SP[0][(((1 & U) << 5) | (U >>> 27)) ^ u[C]] ^
                SP[1][((U >>> 23) & 63) ^ u[C + 1]] ^
                SP[2][((U >>> 19) & 63) ^ u[C + 2]] ^
                SP[3][((U >>> 15) & 63) ^ u[C + 3]] ^
                SP[4][((U >>> 11) & 63) ^ u[C + 4]] ^
                SP[5][((U >>> 7) & 63) ^ u[C + 5]] ^
                SP[6][((U >>> 3) & 63) ^ u[C + 6]] ^
                SP[7][(((31 & U) << 1) | (U >>> 31)) ^ u[C + 7]];
      const S = m ^ x; m = U; U = S;
    }
    let T = m; m = U; U = T;

    for (let B = 0; B < 128; B += 8) {
      const E = SP[0][(((1 & U) << 5) | (U >>> 27)) ^ a[B]] ^
                SP[1][((U >>> 23) & 63) ^ a[B + 1]] ^
                SP[2][((U >>> 19) & 63) ^ a[B + 2]] ^
                SP[3][((U >>> 15) & 63) ^ a[B + 3]] ^
                SP[4][((U >>> 11) & 63) ^ a[B + 4]] ^
                SP[5][((U >>> 7) & 63) ^ a[B + 5]] ^
                SP[6][((U >>> 3) & 63) ^ a[B + 6]] ^
                SP[7][(((31 & U) << 1) | (U >>> 31)) ^ a[B + 7]];
      const D = m ^ E; m = U; U = D;
    }
    T = m; m = U; U = T;

    for (let _ = 0; _ < 128; _ += 8) {
      const I = SP[0][(((1 & U) << 5) | (U >>> 27)) ^ i[_]] ^
                SP[1][((U >>> 23) & 63) ^ i[_ + 1]] ^
                SP[2][((U >>> 19) & 63) ^ i[_ + 2]] ^
                SP[3][((U >>> 15) & 63) ^ i[_ + 3]] ^
                SP[4][((U >>> 11) & 63) ^ i[_ + 4]] ^
                SP[5][((U >>> 7) & 63) ^ i[_ + 5]] ^
                SP[6][((U >>> 3) & 63) ^ i[_ + 6]] ^
                SP[7][(((31 & U) << 1) | (U >>> 31)) ^ i[_ + 7]];
      const O = m ^ I; m = U; U = O;
    }

    const k = U >>> 24, q = (U >>> 16) & 255, P = (U >>> 8) & 255, H = 255 & U;
    const K = m >>> 24, M = (m >>> 16) & 255, N = (m >>> 8) & 255, R = 255 & m;
    const L = FP_HI[0][k] | FP_HI[1][q] | FP_HI[2][P] | FP_HI[3][H] | FP_HI[4][K] | FP_HI[5][M] | FP_HI[6][N] | FP_HI[7][R];
    const V = FP_LO[0][k] | FP_LO[1][q] | FP_LO[2][P] | FP_LO[3][H] | FP_LO[4][K] | FP_LO[5][M] | FP_LO[6][N] | FP_LO[7][R];

    c[l] = L >>> 24; c[l + 1] = (L >>> 16) & 255; c[l + 2] = (L >>> 8) & 255; c[l + 3] = 255 & L;
    c[l + 4] = V >>> 24; c[l + 5] = (V >>> 16) & 255; c[l + 6] = (V >>> 8) & 255; c[l + 7] = 255 & V;
  }
  return c;
}

const DEFAULT_3DES_KEY = hexToBytes("e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8");

function wrap(str) {
  const plainBytes = utf8Encode(str);
  const padLen = 8 - (plainBytes.length % 8);
  const padded = new Uint8Array(plainBytes.length + padLen);
  padded.set(plainBytes);
  for (let i = plainBytes.length; i < padded.length; i++) padded[i] = padLen;
  const encrypted = runFast3DES(padded, DEFAULT_3DES_KEY, false);
  const b64 = b64encode(encrypted);
  return bytesToHex(utf8Encode(b64));
}

function unwrap(hexStr) {
  const b64Bytes = hexToBytes(hexStr);
  const b64 = utf8Decode(b64Bytes);
  const encrypted = b64decode(b64);
  const decrypted = runFast3DES(encrypted, DEFAULT_3DES_KEY, true);
  if (!decrypted.length) return "";
  const pad = decrypted[decrypted.length - 1];
  const actualLen = pad >= 1 && pad <= 8 ? decrypted.length - pad : decrypted.length;
  return utf8Decode(decrypted.subarray(0, actualLen));
}

// MD5 rápido en puro JS (solo se usa para derivar "sn" a partir de snToken+SALT)
function md5(string) {
  function cmn(q, a, b, x, s, t) {
    a = (a + q + x + t) & 0xFFFFFFFF;
    return (((a << s) | (a >>> (32 - s))) + b) & 0xFFFFFFFF;
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }

  const n = string.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) {
    cycle(state, blk(string.substring(i - 64, i)));
  }
  const rem = string.substring(i - 64);
  const tail = new Array(16).fill(0);
  for (i = 0; i < rem.length; i++) tail[i >> 2] |= rem.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  cycle(state, tail);

  function cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);

    x[0] = (x[0] + a) & 0xFFFFFFFF; x[1] = (x[1] + b) & 0xFFFFFFFF;
    x[2] = (x[2] + c) & 0xFFFFFFFF; x[3] = (x[3] + d) & 0xFFFFFFFF;
  }

  function blk(s) {
    const b = new Array(16).fill(0);
    for (let i = 0; i < 64; i += 4) {
      b[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return b;
  }

  const hchr = "0123456789abcdef";
  let out = "";
  for (let j = 0; j < 4; j++) {
    for (let k = 0; k < 4; k++) {
      out += hchr[(state[j] >> (k * 8 + 4)) & 0x0F] + hchr[(state[j] >> (k * 8)) & 0x0F];
    }
  }
  return out;
}

// Desempaqueta el campo data/res de una respuesta del portal si viene
// cifrado (string hex largo), igual que hacía worker5.js en callPortal().
function extractPortalData(json) {
  let data = (json && (json.res || json.data)) || null;
  if (typeof data === "string" && data.length > 16 && /^[0-9a-fA-F]+$/i.test(data)) {
    try { data = JSON.parse(unwrap(data)); } catch (e) { data = unwrap(data); }
  }
  return data;
}

// Convierte puertos decimales o hexadecimales (p. ej. 3128 / 0xC38).
// El hexadecimal es el formato usado por Smali; no es un sistema sexagesimal.
function decodeProxyPort(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Puerto de proxy vacío");
  const port = /^0x[0-9a-f]+$/i.test(raw)
    ? Number.parseInt(raw.slice(2), 16)
    : (/^[0-9]+$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Puerto inválido: ${raw}`);
  }
  return port;
}

function parseProxyAddress(value, defaultPortRaw = "", credentials = {}) {
  let token = String(value || "").trim();
  let type = "http";
  const scheme = token.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    type = scheme[1].toLowerCase();
    if (!["http", "socks4", "socks4a", "socks5"].includes(type)) {
      throw new Error(`Protocolo de proxy no admitido: ${type}`);
    }
    const u = new URL(token);
    if (u.username || u.password) {
      credentials = {
        username: decodeURIComponent(u.username || ""),
        password: decodeURIComponent(u.password || "")
      };
    }
    if ((u.pathname !== "" && u.pathname !== "/") || u.search || u.hash) throw new Error(`Formato de proxy inválido: ${value}`);
    token = u.host;
  }
  const match = token.match(/^(\[[0-9a-f:]+\]|[^:]+)(?::(.+))?$/i);
  if (!match) throw new Error(`Formato de proxy inválido: ${value}`);
  const host = match[1].replace(/^\[|\]$/g, "").trim();
  const portText = match[2] || defaultPortRaw;
  if (!portText) throw new Error(`Falta puerto en ${host}`);
  if (!/^(?:[a-z0-9.-]+|[0-9a-f:]+)$/i.test(host)) throw new Error(`IP/host inválido: ${host}`);
  return {
    type, host, port: decodeProxyPort(portText),
    username: String(credentials.username || ""),
    password: String(credentials.password || "")
  };
}

function parseProxyList(env) {
  const credentials = {
    username: String(env.PROXY_USERNAME || ""),
    password: String(env.PROXY_PASSWORD || "")
  };
  const defaultPortRaw = String(env.PROXY_PORT_HEX || env.PROXY_PORT || "").trim();
  const entries = [];
  const rawList = String(env.PROXY_LIST || "").trim();
  if (rawList) {
    if (rawList.startsWith("[")) {
      let parsed;
      try { parsed = JSON.parse(rawList); }
      catch { throw new Error("PROXY_LIST contiene JSON inválido"); }
      if (!Array.isArray(parsed)) throw new Error("PROXY_LIST JSON debe ser una lista");
      for (const item of parsed) {
        if (typeof item === "string") entries.push(parseProxyAddress(item, defaultPortRaw, credentials));
        else if (item && typeof item === "object") {
          const p = parseProxyAddress(
            item.url || `${item.type || "http"}://${item.host}:${item.port}`,
            defaultPortRaw,
            { username: item.username ?? credentials.username, password: item.password ?? credentials.password }
          );
          entries.push(p);
        }
      }
    } else {
      for (const token of rawList.split(/[\s,;]+/).filter(Boolean)) {
        entries.push(parseProxyAddress(token, defaultPortRaw, credentials));
      }
    }
  }
  if (!entries.length && env.PROXY_HOST) {
    entries.push(parseProxyAddress(
      `${env.PROXY_TYPE || "http"}://${String(env.PROXY_HOST).trim()}:${env.PROXY_PORT_HEX || env.PROXY_PORT}`,
      defaultPortRaw,
      credentials
    ));
  }
  return dedupeProxies(entries);
}

function dedupeProxies(entries) {
  const seen = new Set();
  return entries.filter(p => {
    const key = `${p.type}|${p.host.toLowerCase()}|${p.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

let proxyRotationCursor = 0;

function getConfig(env) {
  // La lista puede estar guardada en PROXY_STORE (panel); no exigir PROXY_LIST.
  const proxies = parseProxyList(env);
  const targetHost = String(env.TARGET_HOST || DEFAULT_TARGET_HOST).trim();
  const portalCode = String(env.PORTAL_CODE || PORTAL_CONFIG.portalCode).trim();
  if (!/^[a-z0-9.-]+$/i.test(targetHost)) {
    throw new Error("TARGET_HOST no es un hostname válido");
  }
  return { proxies, targetHost, portalCode };
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function findHeaderEnd(bytes) {
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 &&
        bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function decodeChunked(bytes) {
  const output = [];
  let offset = 0;

  while (offset < bytes.length) {
    let lineEnd = -1;

    for (let i = offset; i < bytes.length - 1; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10) {
        lineEnd = i;
        break;
      }
    }

    if (lineEnd < 0) {
      throw new Error("Respuesta chunked incompleta: falta CRLF");
    }

    const sizeLine = new TextDecoder().decode(
      bytes.subarray(offset, lineEnd)
    ).trim();

    const sizeToken = sizeLine.split(";")[0].trim();
    const size = Number.parseInt(sizeToken, 16);

    if (!Number.isFinite(size) || size < 0) {
      throw new Error("Tamaño de chunk inválido");
    }

    offset = lineEnd + 2;

    if (size === 0) {
      // Después del chunk cero pueden venir trailers y una línea vacía.
      break;
    }

    if (offset + size + 2 > bytes.length) {
      throw new Error("Respuesta chunked incompleta: chunk truncado");
    }

    output.push(bytes.subarray(offset, offset + size));
    offset += size;

    if (bytes[offset] !== 13 || bytes[offset + 1] !== 10) {
      throw new Error("Separador de chunk inválido");
    }
    offset += 2;
  }

  return concatChunks(output);
}

function makeAbortTimeout(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return {
    promise,
    clear: () => clearTimeout(timer)
  };
}

function safeRequestHeaders(inputHeaders, targetHost, bodyBytes) {
  const headers = new Headers(inputHeaders || {});

  // Estos encabezados pertenecen a la conexión cliente -> Worker,
  // no a la conexión Worker -> portal.
  for (const name of [
    "host",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "content-length"
  ]) {
    headers.delete(name);
  }

  headers.set("Host", targetHost);
  headers.set("Connection", "close");

  if (bodyBytes) {
    headers.set("Content-Length", String(bodyBytes.byteLength));
  }

  return headers;
}

async function writeSocket(socket, bytes) {
  const writer = socket.writable.getWriter();
  try { await writer.write(bytes); } finally { writer.releaseLock(); }
}

async function readSocketExact(reader, count, timeoutMs = CONNECT_TIMEOUT_MS) {
  const chunks = [];
  let total = 0;
  const timeout = makeAbortTimeout(timeoutMs, "Tiempo agotado durante handshake SOCKS");
  try {
    const read = (async () => {
      while (total < count) {
        const { value, done } = await reader.read();
        if (done) throw new Error("El proxy cerró la conexión durante handshake SOCKS");
        chunks.push(value);
        total += value.byteLength;
        if (total > 65536) throw new Error("Respuesta SOCKS demasiado grande");
      }
      const all = concatChunks(chunks);
      return { bytes: all.subarray(0, count), extra: all.subarray(count) };
    })();
    return await Promise.race([read, timeout.promise]);
  } finally { timeout.clear(); }
}

function ipv4Bytes(address) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(x => !/^\d+$/.test(x) || Number(x) > 255)) {
    throw new Error(`Dirección IPv4 inválida: ${address}`);
  }
  return Uint8Array.from(parts.map(Number));
}

async function resolveIPv4(host) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return ipv4Bytes(host);
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: "application/dns-json" }
  });
  if (!response.ok) throw new Error(`No se pudo resolver ${host} para SOCKS4`);
  const data = await response.json();
  const answer = (data.Answer || []).find(x => x.type === 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(x.data));
  if (!answer) throw new Error(`No se encontró IPv4 para ${host} (SOCKS4 requiere IPv4)`);
  return ipv4Bytes(answer.data);
}

// readSocketExact() puede recibir en una sola lectura más bytes de los pedidos
// (p. ej. un proxy SOCKS que manda la respuesta del CONNECT en un solo paquete).
// Ese sobrante ("extra") antes se descartaba, y el siguiente paso del handshake
// se quedaba esperando bytes que ya habían llegado: el túnel SOCKS se colgaba
// hasta agotar el timeout, incluso con un proxy sano. makeExactReader() guarda
// ese sobrante y lo reutiliza en la próxima lectura exacta.
function makeExactReader(reader) {
  let leftover = new Uint8Array(0);
  return {
    async readExact(count, timeoutMs = CONNECT_TIMEOUT_MS) {
      const chunks = leftover.byteLength ? [leftover] : [];
      let total = leftover.byteLength;
      leftover = new Uint8Array(0);
      const timeout = makeAbortTimeout(timeoutMs, "Tiempo agotado durante handshake SOCKS");
      try {
        const read = (async () => {
          while (total < count) {
            const { value, done } = await reader.read();
            if (done) throw new Error("El proxy cerró la conexión durante handshake SOCKS");
            chunks.push(value);
            total += value.byteLength;
            if (total > 65536) throw new Error("Respuesta SOCKS demasiado grande");
          }
          const all = concatChunks(chunks);
          leftover = all.subarray(count);
          return all.subarray(0, count);
        })();
        return await Promise.race([read, timeout.promise]);
      } finally {
        timeout.clear();
      }
    }
  };
}

async function establishSocksTunnel(socket, proxy, targetHost, targetPort) {
  const reader = socket.readable.getReader();
  const exact = makeExactReader(reader);
  try {
    if (proxy.type === "socks5") {
      const hasAuth = Boolean(proxy.username || proxy.password);
      await writeSocket(socket, hasAuth
        ? Uint8Array.of(5, 2, 0, 2)
        : Uint8Array.of(5, 1, 0));
      const method = await exact.readExact(2);
      if (method[0] !== 5 || method[1] === 255) throw new Error("SOCKS5: el proxy rechazó los métodos de autenticación");
      if (method[1] === 2) {
        if (!hasAuth) throw new Error("SOCKS5: el proxy exige usuario y contraseña");
        const u = new TextEncoder().encode(proxy.username);
        const p = new TextEncoder().encode(proxy.password);
        if (u.length > 255 || p.length > 255) throw new Error("Credenciales SOCKS5 demasiado largas");
        const auth = new Uint8Array(3 + u.length + p.length);
        auth.set([1, u.length], 0); auth.set(u, 2);
        auth[2 + u.length] = p.length; auth.set(p, 3 + u.length);
        await writeSocket(socket, auth);
        const authReply = await exact.readExact(2);
        if (authReply[1] !== 0) throw new Error("SOCKS5: autenticación rechazada");
      } else if (method[1] !== 0) {
        throw new Error(`SOCKS5: método no compatible (${method[1]})`);
      }
      const hostBytes = new TextEncoder().encode(targetHost);
      if (hostBytes.length > 255) throw new Error("Hostname demasiado largo para SOCKS5");
      const request = new Uint8Array(7 + hostBytes.length);
      request.set([5, 1, 0, 3, hostBytes.length], 0);
      request.set(hostBytes, 5);
      request[5 + hostBytes.length] = (targetPort >> 8) & 255;
      request[6 + hostBytes.length] = targetPort & 255;
      await writeSocket(socket, request);
      const head = await exact.readExact(4);
      if (head[0] !== 5 || head[1] !== 0) throw new Error(`SOCKS5 CONNECT rechazado (código ${head[1]})`);
      const addrLen = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3
        ? (await exact.readExact(1))[0] : 0;
      if (!addrLen) throw new Error("SOCKS5: tipo de dirección inválido");
      await exact.readExact(addrLen + 2);
      return;
    }

    // SOCKS4a delega la resolución DNS al servidor proxy.
    let dst;
    let user = new TextEncoder().encode(proxy.username || "");
    if (user.length > 255) throw new Error("SOCKS4 userid demasiado largo");
    let hostSuffix = new Uint8Array(0);
    if (proxy.type === "socks4a") {
      const host = new TextEncoder().encode(targetHost);
      hostSuffix = new Uint8Array(host.length + 1);
      hostSuffix.set(host); hostSuffix[host.length] = 0;
      dst = Uint8Array.of(0, 0, 0, 1);
    } else {
      dst = await resolveIPv4(targetHost);
    }
    const packet = new Uint8Array(8 + user.length + 1 + hostSuffix.length);
    packet.set([4, 1, (targetPort >> 8) & 255, targetPort & 255], 0);
    packet.set(dst, 4);
    packet.set(user, 8);
    packet[8 + user.length] = 0;
    packet.set(hostSuffix, 9 + user.length);
    await writeSocket(socket, packet);
    const reply = await exact.readExact(8);
    if (reply[1] !== 90) throw new Error(`SOCKS4${proxy.type === "socks4a" ? "a" : ""} CONNECT rechazado (código ${reply[1]})`);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function fetchViaProxyOnce(env, targetUrl, init = {}, proxy) {
  const url = new URL(targetUrl);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Solo se permiten destinos HTTP y HTTPS");
  }

  const isHttps = url.protocol === "https:";
  const targetHost = url.hostname;
  const targetPort = Number(url.port || (isHttps ? 443 : 80));

  let socket;
  let reader;
  let activeSocket;
  let targetRequestSent = false;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  try {
    socket = connect(
      { hostname: proxy.host, port: proxy.port },
      { secureTransport: "starttls" }
    );

    // 1. Establecer túnel según el protocolo declarado en la lista.
    const proxyType = proxy.type || "http";
    if (proxyType === "socks4" || proxyType === "socks4a" || proxyType === "socks5") {
      await establishSocksTunnel(socket, { ...proxy, type: proxyType }, targetHost, targetPort);
    } else {
      const auth = proxy.username && proxy.password
        ? `Proxy-Authorization: Basic ${btoa(`${proxy.username}:${proxy.password}`)}\r\n`
        : "";
      const connectRequest =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        auth +
        "Proxy-Connection: keep-alive\r\n" +
        "Connection: keep-alive\r\n\r\n";

      await writeSocket(socket, encoder.encode(connectRequest));
      reader = socket.readable.getReader();
      const connectChunks = [];
      let connectBytes = new Uint8Array(0);
      const connectTimeout = makeAbortTimeout(CONNECT_TIMEOUT_MS, "Tiempo de espera agotado en CONNECT al proxy");
      try {
        const readHeaders = (async () => {
          while (findHeaderEnd(connectBytes) < 0) {
            const { value, done } = await reader.read();
            if (done) throw new Error("El proxy cerró la conexión durante CONNECT");
            connectChunks.push(value);
            connectBytes = concatChunks(connectChunks);
            if (connectBytes.byteLength > 32768) throw new Error("Cabeceras CONNECT demasiado grandes");
          }
        })();
        await Promise.race([readHeaders, connectTimeout.promise]);
      } finally {
        connectTimeout.clear();
        try { reader.releaseLock(); } catch {}
        reader = null;
      }
      const connectEnd = findHeaderEnd(connectBytes);
      const connectStatus = decoder.decode(connectBytes.subarray(0, connectEnd)).split("\r\n")[0] || "";
      if (!/^HTTP\/1\.[01]\s+200(?:\s|$)/i.test(connectStatus)) {
        throw new Error(`El proxy HTTP rechazó CONNECT: ${connectStatus}`);
      }
    }

    // 2. Subir TLS dentro del túnel cuando el destino es HTTPS.
    activeSocket = socket;
    if (isHttps) {
      activeSocket = socket.startTls({
        expectedServerHostname: targetHost
      });
    }

    // 3. Preparar el cuerpo como bytes. ArrayBuffer no se escribe
    // directamente en WritableStream: se convierte a Uint8Array.
    let bodyBytes = null;
    if (init.body != null) {
      if (typeof init.body === "string") {
        bodyBytes = encoder.encode(init.body);
      } else if (init.body instanceof ArrayBuffer) {
        bodyBytes = new Uint8Array(init.body);
      } else if (ArrayBuffer.isView(init.body)) {
        bodyBytes = new Uint8Array(
          init.body.buffer,
          init.body.byteOffset,
          init.body.byteLength
        );
      } else {
        throw new Error("Tipo de body no compatible con el proxy");
      }
    }

    const method = String(init.method || "GET").toUpperCase();
    const headers = safeRequestHeaders(
      init.headers,
      targetHost,
      bodyBytes
    );

    let requestText = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    for (const [name, value] of headers.entries()) {
      requestText += `${name}: ${value}\r\n`;
    }
    requestText += "\r\n";

    const targetWriter = activeSocket.writable.getWriter();
    try {
      targetRequestSent = true;
      await targetWriter.write(encoder.encode(requestText));
      if (bodyBytes && bodyBytes.byteLength) {
        await targetWriter.write(bodyBytes);
      }
    } finally {
      targetWriter.releaseLock();
    }

    // 4. Leer la respuesta HTTP completa.
    // Nota: esta implementación almacena la respuesta en memoria.
    // Es adecuada para API, imágenes y respuestas pequeñas/medianas;
    // para VOD de gran tamaño conviene implementar streaming por bloques.
    reader = activeSocket.readable.getReader();

    const responseChunks = [];
    let responseBytes = new Uint8Array(0);
    const responseTimeout = makeAbortTimeout(
      RESPONSE_TIMEOUT_MS,
      "Tiempo de espera agotado leyendo la respuesta del portal"
    );

    try {
      const readResponse = (async () => {
        let headerFound = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          responseChunks.push(value);
          responseBytes = concatChunks(responseChunks);

          if (!headerFound && findHeaderEnd(responseBytes) >= 0) {
            headerFound = true;
          }
        }
      })();

      await Promise.race([readResponse, responseTimeout.promise]);
    } finally {
      responseTimeout.clear();
      try { reader.releaseLock(); } catch {}
      reader = null;
    }

    const headerEnd = findHeaderEnd(responseBytes);
    if (headerEnd < 0) {
      throw new Error("Respuesta HTTP inválida: no se encontraron cabeceras");
    }

    const headerText = decoder.decode(responseBytes.subarray(0, headerEnd));
    const lines = headerText.split("\r\n");
    const statusLine = lines.shift() || "";
    const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);

    if (!statusMatch) {
      throw new Error(`Línea de estado HTTP inválida: ${statusLine}`);
    }

    const status = Number(statusMatch[1]);
    const responseHeaders = new Headers();
    let isChunked = false;

    const hopByHop = new Set([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade"
    ]);

    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;

      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();

      if (name.toLowerCase() === "transfer-encoding" &&
          value.toLowerCase().includes("chunked")) {
        isChunked = true;
        continue;
      }

      if (!hopByHop.has(name.toLowerCase())) {
        responseHeaders.append(name, value);
      }
    }

    let responseBody = responseBytes.subarray(headerEnd + 4);

    if (isChunked) {
      responseBody = decodeChunked(responseBody);
    }

    if (method === "HEAD" || status === 204 || status === 304) {
      responseBody = new Uint8Array(0);
    }

    responseHeaders.delete("content-length");
    responseHeaders.set("Content-Length", String(responseBody.byteLength));

    return new Response(
      (status === 204 || status === 304 || method === "HEAD")
        ? null
        : responseBody,
      {
        status,
        headers: responseHeaders
      }
    );
  } catch (error) {
    try { reader?.releaseLock(); } catch {}
    try { activeSocket?.close(); } catch {}
    if (!activeSocket) {
      try { socket?.close(); } catch {}
    }
    if (error && typeof error === "object") error.proxyStage = !targetRequestSent;
    throw error;
  } finally {
    try { reader?.releaseLock(); } catch {}
    try { activeSocket?.close(); } catch {}
    if (!activeSocket) {
      try { socket?.close(); } catch {}
    }
  }
}

async function getActiveProxyEntries(env) {
  if (env.PROXY_STORE) {
    const saved = await env.PROXY_STORE.get("active-proxies");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const entries = parsed.map(item => ({
          type: ["http","socks4","socks4a","socks5"].includes(item.type) ? item.type : "http",
          host:String(item.host), port:decodeProxyPort(item.port),
          username:String(item.username || ""), password:String(item.password || "")
        }));
        const primaryRaw = await env.PROXY_STORE.get("primary-proxy");
        if (primaryRaw) {
          try {
            const primary = JSON.parse(primaryRaw);
            const expiry = primary.expiresAt
              ? Date.parse(primary.expiresAt)
              : (primary.selectedAt ? Date.parse(primary.selectedAt) + 4 * 60 * 60 * 1000 : 0);
            const stillPinned = Number.isFinite(expiry) && expiry > Date.now();
            const idx = stillPinned ? entries.findIndex(p => p.host === primary.host && p.port === Number(primary.port) && p.type === (primary.type || "http")) : -1;
            if (idx > 0) entries.unshift(...entries.splice(idx, 1));
          } catch {}
        }
        return entries;
      }
    }
  }
  return parseProxyList(env);
}

async function setPrimaryProxy(env, proxy, reason = "selected") {
  if (!env.PROXY_STORE) return;
  const selectedAt = Date.now();
  await env.PROXY_STORE.put("primary-proxy", JSON.stringify({
    type: proxy.type || "http", host:proxy.host, port:proxy.port,
    selectedAt:new Date(selectedAt).toISOString(),
    expiresAt:new Date(selectedAt + 4 * 60 * 60 * 1000).toISOString(), reason
  }), { expirationTtl: 4 * 60 * 60 });
}
function parseSubmittedProxies(text, env) {
  const defaultPort = String(env.PROXY_PORT_HEX || env.PROXY_PORT || "").trim();
  const candidates = [];
  const rejected = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (!line || line.startsWith("#")) continue;
    for (const tokenRaw of line.split(/[;,]+/)) {
      const token = tokenRaw.trim();
      if (!token) continue;
      try {
        candidates.push(parseProxyAddress(token, defaultPort, {
          username: env.PROXY_USERNAME || "", password: env.PROXY_PASSWORD || ""
        }));
      } catch (error) {
        rejected.push({ proxy: token, reason: `Línea ${lineIndex + 1}: ${error.message}` });
      }
      if (candidates.length + rejected.length > 200) throw new Error("Máximo 200 entradas por carga");
    }
  }
  const unique = dedupeProxies(candidates);
  if (!unique.length && !rejected.length) throw new Error("Pegá al menos una proxy con protocolo y puerto");
  return { candidates: unique, rejected };
}

function adminAuthorized(request, env) {
  const expected = String(env.ADMIN_KEY || "");
  const supplied = request.headers.get("X-Admin-Key") || "";
  return expected.length >= 16 && supplied.length === expected.length && supplied === expected;
}

async function testOneProxy(env, proxy) {
  const targetHost = String(env.TARGET_HOST || DEFAULT_TARGET_HOST).trim();
  if (!/^[a-z0-9.-]+$/i.test(targetHost)) throw new Error("TARGET_HOST no es válido");
  const testUrl = `https://${targetHost}/`;
  const response = await fetchViaProxyOnce(env, testUrl, {
    method: "GET",
    headers: { Accept: "text/html,application/json", "User-Agent": "Xuper-Worker-Proxy-Check/1.0" }
  }, proxy);
  const body = (await response.text()).slice(0, 1200);
  // Un 403/429 aislado no demuestra que el proxy esté muerto: puede ser
  // una política del endpoint raíz o un límite temporal. Solo descartar
  // cuando el cuerpo identifica explícitamente un bloqueo geográfico.
  const blocked = /geo.?block|not available in your (country|region)|country.?not.?allowed|地域制限|地区限制/i.test(body);
  if (blocked) {
    throw new Error(`Xuper rechazó la salida (HTTP ${response.status}; posible geobloqueo)`);
  }
  if (response.status >= 500) throw new Error(`Xuper respondió HTTP ${response.status}`);
  return { status: response.status, message: `Túnel proxy + TLS correctos; Xuper respondió HTTP ${response.status}` };
}

const PROXY_PANEL_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xuper · Administración de proxies</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{font:15px system-ui;background:#0d131c;color:#edf2f7;margin:0;padding:22px}main{max-width:1120px;margin:auto}h1{font-size:25px;margin:0 0 8px}.muted,.hint{color:#9eacbd}.login{max-width:420px;margin:12vh auto;background:#172230;padding:24px;border:1px solid #2b3b4e;border-radius:15px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}.panel{background:#151f2c;border:1px solid #2a394b;border-radius:14px;padding:18px;min-width:0}.panel h2{font-size:18px;margin:0 0 8px}input,textarea{width:100%;padding:12px;border:1px solid #3b4b5e;border-radius:9px;background:#0e1722;color:white;margin:8px 0 14px}textarea{height:250px;font:14px ui-monospace,monospace;resize:vertical}button{padding:11px 16px;border:0;border-radius:9px;background:#2878d0;color:white;font-weight:700;cursor:pointer}button.secondary{background:#334155}button:disabled{opacity:.55;cursor:wait}.proxy{display:flex;align-items:center;gap:9px;padding:10px 0;border-bottom:1px solid #293747;font:13px ui-monospace,monospace;overflow-wrap:anywhere}.dot{width:11px;height:11px;border-radius:50%;background:#64748b;flex:none}.dot.ok{background:#22c55e;box-shadow:0 0 8px #22c55e88}.dot.bad{background:#ef4444}.status{font:12px system-ui;color:#aab7c6;margin-left:auto;text-align:right}.list{max-height:390px;overflow:auto}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.msg{white-space:pre-wrap;overflow-wrap:anywhere;background:#0e1722;padding:12px;border-radius:9px;margin-top:12px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.small{font-size:12px}.hidden{display:none!important}@media(max-width:760px){.cols{grid-template-columns:1fr}body{padding:14px}.panel{padding:14px}}
</style></head><body><main>
<section id="login" class="login"><h1>Acceso a proxies Xuper</h1><p class="muted">Ingresá la contraseña de administración para ver y gestionar las listas.</p><form id="loginForm"><label for="key">Contraseña</label><input id="key" type="password" autocomplete="current-password" placeholder="Contraseña de administrador" required><button id="enter" type="submit">Ingresar</button></form><div id="loginMsg" class="msg hidden" role="status" aria-live="polite"></div></section>
<section id="app" class="hidden"><div class="top"><div><h1>Administración de proxies</h1><div class="muted small">Cambios guardados en el Worker sin editar ni desplegar el código.</div></div><div class="toolbar"><button id="refresh" class="secondary">Actualizar estado</button><button id="logout" class="secondary">Cerrar sesión</button></div></div>
<div class="cols"><section class="panel"><h2>1. Proxies configuradas</h2><p class="muted small">Son las direcciones que ya vienen configuradas dentro del Worker. El indicador verde confirma que CONNECT + TLS y una respuesta de Xuper funcionaron en esta comprobación.</p><div id="embedded" class="list"><p class="muted">Ingresá para consultar.</p></div></section>
<section class="panel"><h2>2. Cargar proxies nuevas</h2><p class="muted small">Admite HTTP, SOCKS4, SOCKS4a y SOCKS5. Una dirección por línea, con protocolo://IP:PUERTO.</p><textarea id="newList" placeholder="http://51.85.44.149:3128&#10;socks4://192.0.2.10:1080&#10;socks4a://192.0.2.11:1080&#10;socks5://192.0.2.12:1080"></textarea><div class="toolbar"><button id="load">Comprobar y cargar</button></div><div id="result" class="msg">HTTP · SOCKS4 · SOCKS4a · SOCKS5. La principal queda fijada 4 horas.</div><h2 style="margin-top:20px">Proxies actualmente activas</h2><div id="active" class="list"><p class="muted">Pendiente de consultar.</p></div></section></div>
<p class="hint small">Una proxy marcada como viva solo superó la prueba técnica contra el host de Xuper en ese momento. No garantiza que la API de activación, renovación o reproducción acepte esa salida. Los indicadores se actualizan cuando pulsás “Actualizar estado”.</p></section></main><script>
const $=id=>document.getElementById(id);let adminKey='';
async function api(path,options={}){let r;try{r=await fetch(path,{...options,headers:{...(options.headers||{}),'X-Admin-Key':adminKey},cache:'no-store'})}catch(e){throw new Error('No se pudo conectar con el Worker: '+(e.message||'revisá tu conexión'))}const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{throw new Error('El Worker devolvió una respuesta no válida (HTTP '+r.status+'). Verificá que hayas desplegado la versión v3.')}if(r.status===401)throw new Error('Contraseña incorrecta: revisá el secreto ADMIN_KEY');if(!r.ok||j.ok===false)throw new Error(j.error||('Error HTTP '+r.status));return j}
function drawList(el,items){el.innerHTML='';if(!items||!items.length){el.innerHTML='<p class="muted small">No hay proxies en esta lista.</p>';return}for(const p of items){const row=document.createElement('div');row.className='proxy';const dot=document.createElement('span');dot.className='dot '+(p.live?'ok':p.live===false?'bad':'');const addr=document.createElement('span');addr.textContent=p.address;const st=document.createElement('span');st.className='status';st.textContent=p.live?(p.message||'VIVA'):(p.live===false?(p.message||'NO RESPONDE'):'Sin comprobar');row.append(dot,addr,st);el.append(row)}}
async function refresh(){ $('refresh').disabled=true;$('embedded').textContent='Comprobando proxies configuradas…';$('active').textContent='Comprobando proxies activas…';try{const j=await api('/admin/proxies/status');drawList($('embedded'),j.embedded);drawList($('active'),j.active);$('result').textContent='Última comprobación: '+new Date(j.checkedAt).toLocaleString()+'\nIncrustadas vivas: '+j.embedded.filter(x=>x.live).length+'/'+j.embedded.length+'\nActivas vivas: '+j.active.filter(x=>x.live).length+'/'+j.active.length}catch(e){$('result').textContent='Error: '+e.message;if(e.message==='Contraseña incorrecta')logout()}finally{$('refresh').disabled=false}}
function logout(){adminKey='';sessionStorage.removeItem('xuper_admin_key');$('app').classList.add('hidden');$('login').classList.remove('hidden');$('key').value=''}
$('loginForm').addEventListener('submit',async(ev)=>{ev.preventDefault();const b=$('enter');adminKey=$('key').value.trim();$('loginMsg').textContent='Conectando con el Worker y verificando la contraseña…';$('loginMsg').classList.remove('hidden');b.disabled=true;b.textContent='Verificando…';try{await api('/admin/proxies/status');sessionStorage.setItem('xuper_admin_key',adminKey);$('login').classList.add('hidden');$('app').classList.remove('hidden');await refresh()}catch(e){adminKey='';$('loginMsg').textContent='No se pudo ingresar: '+e.message;$('loginMsg').classList.remove('hidden')}finally{b.disabled=false;b.textContent='Ingresar'}});
$('load').onclick=async()=>{const b=$('load');b.disabled=true;b.textContent='Probando y cargando…';$('result').textContent='Probando cada dirección contra Xuper. No cierres esta página…';try{const j=await api('/admin/proxies/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proxies:$('newList').value})});$('result').textContent='Comprobadas: '+j.tested+'/'+j.total+'\nOperativas guardadas: '+j.savedCount+'\nReservas: '+j.fallbackCount+'\nRechazadas (formato o conexión): '+j.rejected.length+'\n\n'+(j.primary?'Principal: '+j.primary+'\n\n':'')+(j.rejected.map(x=>x.proxy+' — '+x.reason).join('\n')||'Todas las proxies superaron la prueba.');await refresh()}catch(e){$('result').textContent='Error: '+e.message;if(e.message==='Contraseña incorrecta')logout()}finally{b.disabled=false;b.textContent='Comprobar y cargar'}};
$('refresh').onclick=refresh;$('logout').onclick=logout;
try{adminKey=sessionStorage.getItem('xuper_admin_key')||'';if(adminKey){$('key').value=adminKey;$('loginForm').requestSubmit()}}catch(e){adminKey='';}
</script></body></html>`;

async function fetchViaProxy(env, targetUrl, init = {}) {
  const proxies = await getActiveProxyEntries(env);
  if (!proxies.length) throw new Error("No hay proxies cargados: usá /admin/proxies para agregar una lista");
  let lastError;
  for (let index = 0; index < proxies.length; index++) {
    const proxy = proxies[index];
    try {
      const response = await fetchViaProxyOnce(env, targetUrl, init, proxy);
      // Mantener fija la principal durante 4 horas. Si venció, fijar
      // la primera que acaba de demostrar que funciona.
      let pinned = false;
      if (env.PROXY_STORE) {
        try {
          const raw = await env.PROXY_STORE.get("primary-proxy");
          if (raw) {
            const saved = JSON.parse(raw);
            const expiry = saved.expiresAt
              ? Date.parse(saved.expiresAt)
              : (saved.selectedAt ? Date.parse(saved.selectedAt) + 4 * 60 * 60 * 1000 : 0);
            pinned = Number.isFinite(expiry) && expiry > Date.now();
          }
        } catch {}
      }
      if (index > 0 || !pinned) await setPrimaryProxy(env, proxy, index > 0 ? "failover" : "expired-primary");
      return response;
    } catch (error) {
      lastError = error;
      // Nunca repetir POST si el servidor pudo haber recibido la petición.
      if (!error?.proxyStage) throw error;
      console.warn(`Proxy ${proxy.host}:${proxy.port} falló antes del envío; probando la siguiente`);
    }
  }
  throw new Error(`No se pudo establecer CONNECT con ninguna proxy: ${lastError?.message || "error desconocido"}`);
}
async function readJsonResponse(response, label) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}; ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: el servidor no devolvió JSON válido; ${text.slice(0, 300)}`);
  }
}

// Guarda una sesión (venga de activación automática o de donación manual/
// externa) en KV, con la misma estructura y el mismo TTL que usaba
// performAutoActivation. Se usa desde los dos caminos para no duplicar
// lógica. pool:list siempre deja la más reciente al final, así que
// /session/fallback (y el resto del código que lee "la última sesión")
// automáticamente prioriza la que se guardó último, sea donada o generada.
async function saveSession(env, sessionData) {
  if (!env.SESSIONS) return;
  const ttl = 7 * 24 * 60 * 60;
  await env.SESSIONS.put(
    `sess:${sessionData.userId}`,
    JSON.stringify(sessionData),
    { expirationTtl: ttl }
  );

  let oldList = [];
  try {
    oldList = JSON.parse(await env.SESSIONS.get("pool:list") || "[]");
  } catch {}

  const nextList = [
    ...oldList.filter(id => id !== sessionData.userId),
    sessionData.userId
  ].slice(-20);

  await env.SESSIONS.put(
    "pool:list",
    JSON.stringify(nextList),
    { expirationTtl: ttl }
  );
}

// Devuelve la sesión más reciente guardada en KV (donada o auto-activada),
// o null si no hay ninguna. No intenta activar nada nuevo: solo lee.
async function getLatestSession(env) {
  if (!env.SESSIONS) return null;
  try {
    const rawList = await env.SESSIONS.get("pool:list");
    const list = rawList ? JSON.parse(rawList) : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const raw = await env.SESSIONS.get(`sess:${list[i]}`);
      if (!raw) continue;
      const session = JSON.parse(raw);
      if (session.userId && session.userToken) return session;
    }
  } catch {}
  return null;
}

// Intenta primero por el camino de proxies (sin tocar su lógica), y si
// ese camino falla por completo (no hay proxies cargadas o ninguna
// conecta), reintenta con un fetch directo desde el propio Worker.
// Pensado para llamadas de CONTENIDO (login/listados/startPlayVOD/stream)
// una vez que ya existe una sesión activa: la activación anónima sí suele
// chocar con el geobloqueo del portal, pero una sesión ya autenticada no
// necesariamente, así que vale la pena probar directo como último recurso
// en vez de devolver 502 cuando las proxies gratuitas se caen.
async function fetchContentWithFallback(env, targetUrl, init = {}) {
  let proxyError = null;
  try {
    return await fetchViaProxy(env, targetUrl, init);
  } catch (error) {
    proxyError = error;
  }

  try {
    const directHeaders = safeRequestHeaders(init.headers, new URL(targetUrl).hostname, null);
    const response = await fetch(targetUrl, { ...init, headers: directHeaders });
    return response;
  } catch (directError) {
    throw new Error(
      `Proxy falló (${proxyError?.message || "sin proxies"}) y el fetch directo también falló: ${directError.message}`
    );
  }
}

async function performAutoActivation(env) {
  const config = getConfig(env);

  try {
    const randomSerial = new Uint8Array(16);
    crypto.getRandomValues(randomSerial);
    const sn = Array.from(randomSerial)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const baseFields = {
      loginType: "2",
      appLanguage: "en",
      apkVersion: PORTAL_CONFIG.apkVersion,
      sysVersion: PORTAL_CONFIG.sysVersion,
      appId: PORTAL_CONFIG.appId,
      hardwareInfo: PORTAL_CONFIG.hardwareInfo,
      model: PORTAL_CONFIG.model,
      product: PORTAL_CONFIG.product,
      cpu: PORTAL_CONFIG.cpu,
      B29: "",
      reserve1: "583442714b345572434a4d5769637461545a735936413d3d",
      deviceToken: "",
      drmId: "",
      sdkVer: PORTAL_CONFIG.sdkVer,
      sn
    };

    const headers = {
      apk: PORTAL_CONFIG.appId,
      apkVer: PORTAL_CONFIG.apkHeaderVersion,
      spkgVer: PORTAL_CONFIG.sysVersion,
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "okhttp/3.12.12"
    };

    const tokenPayload = JSON.stringify({
      userId: "",
      userToken: "",
      portalCode: config.portalCode
    });

    // El portal exige el body cifrado en 3DES-ECB (ver bloque de criptografía
    // más arriba); mandarlo en JSON plano es lo que hacía fallar la activación
    // aun con el túnel de proxies funcionando.
    const tokenResponse = await fetchViaProxy(
      env,
      `https://${config.targetHost}/api/portalCore/v3/snToken`,
      {
        method: "POST",
        headers,
        body: wrap(tokenPayload)
      }
    );

    const tokenJson = await readJsonResponse(tokenResponse, "snToken");
    const tokenData = extractPortalData(tokenJson) || {};
    const snToken =
      tokenData.snToken ||
      tokenJson?.res?.snToken ||
      tokenJson?.data?.snToken ||
      "";

    if (!snToken) {
      throw new Error(
        `snToken no devolvió token. Respuesta: ${JSON.stringify(tokenJson).slice(0, 500)}`
      );
    }

    // Si el portal no fija su propio "sn" para este snToken, se deriva con
    // la sal oficial (md5(snToken + PORTAL_SALT)), igual que hace la app.
    const registeredSn = tokenData.sn || sn || md5(snToken + PORTAL_SALT);
    baseFields.sn = registeredSn;

    const activePayload = JSON.stringify({
      authCode: "",
      authVersion: "",
      channel: "default",
      macAddr: "02:00:00:00:00:00",
      matadata: "",
      openNum: 1,
      signdata: "",
      snToken,
      portalCode: config.portalCode,
      ...baseFields
    });

    const activeResponse = await fetchViaProxy(
      env,
      `https://${config.targetHost}/api/portalCore/v8/active`,
      {
        method: "POST",
        headers,
        body: wrap(activePayload)
      }
    );

    const activeJson = await readJsonResponse(activeResponse, "active");
    const data = extractPortalData(activeJson) || activeJson?.res || activeJson?.data || {};

    if (!data.userId || !data.userToken) {
      // No se devuelve ni se registra ningún token.
      throw new Error(
        `La activación no devolvió userId/userToken. HTTP ${activeResponse.status}; ` +
        `respuesta: ${JSON.stringify(activeJson).slice(0, 700)}`
      );
    }

    const sessionData = {
      userId: String(data.userId),
      userToken: String(data.userToken),
      sn: registeredSn,
      snToken,
      ts: Date.now()
    };

    await saveSession(env, sessionData);

    return sessionData;
  } catch (error) {
    throw new Error("Auto-activation failed: " + error.message);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers":
        "X-Server-Time, Content-Range, Content-Length, Accept-Ranges",
      "Cache-Control": "no-store"
    };

    const jsonResponse = (object, status = 200) =>
      new Response(JSON.stringify(object), {
        status,
        headers: {
          ...cors,
          "Content-Type": "application/json; charset=utf-8",
          "X-Server-Time": String(Date.now())
        }
      });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/admin/proxies") {
      if (!env.ADMIN_KEY || String(env.ADMIN_KEY).length < 16) {
        return new Response("Configurá ADMIN_KEY como secreto de al menos 16 caracteres", { status: 503, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
      }
      return new Response(PROXY_PANEL_HTML, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/admin/proxies/status" && request.method === "GET") {
      if (!adminAuthorized(request, env)) return jsonResponse({ ok: false, error: "Clave de administrador incorrecta" }, 401);
      if (!env.PROXY_STORE) return jsonResponse({ ok: false, error: "Falta configurar el binding KV PROXY_STORE" }, 503);
      try {
        let embedded = [];
        try { embedded = parseProxyList(env); } catch {}
        const savedRaw = await env.PROXY_STORE.get("active-proxies");
        const activeSaved = savedRaw ? JSON.parse(savedRaw) : [];
        // Antes se probaba una proxy por vez: con varias direcciones (y sobre todo
        // con alguna caída) el login al panel, que depende de esta misma ruta,
        // podía tardar minutos o directamente no responder. Ahora se prueban en
        // paralelo, igual que ya hacía /admin/proxies/test.
        const check = async (items) => {
          const results = new Array(items.length);
          let cursor = 0;
          const workers = Array.from({ length: Math.min(12, items.length) }, async () => {
            while (true) {
              const index = cursor++;
              if (index >= items.length) return;
              const proxy = items[index];
              const address = `${proxy.type || "http"}://${proxy.host}:${decodeProxyPort(proxy.port)}`;
              try {
                const result = await testOneProxy(env, proxy);
                results[index] = { address, live: true, message: `VIVA · HTTP ${result.status}` };
              } catch (error) {
                results[index] = { address, live: false, message: error.message };
              }
            }
          });
          await Promise.all(workers);
          return results;
        };
        const embeddedResults = await check(embedded);
        const activeResults = await check(activeSaved.map(p => ({
          type: p.type || "http", host: p.host, port: p.port,
          username: String(p.username || env.PROXY_USERNAME || ""),
          password: String(p.password || env.PROXY_PASSWORD || "")
        })));
        return jsonResponse({ ok: true, checkedAt: new Date().toISOString(), embedded: embeddedResults, active: activeResults });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
    }

    if (url.pathname === "/admin/proxies/test" && request.method === "POST") {
      if (!adminAuthorized(request, env)) return jsonResponse({ ok: false, error: "Clave de administrador incorrecta" }, 401);
      if (!env.PROXY_STORE) return jsonResponse({ ok: false, error: "Falta configurar el binding KV PROXY_STORE" }, 503);
      try {
        const input = await request.json();
        const parsed = parseSubmittedProxies(input?.proxies, env);
        const candidates = parsed.candidates;
        const rejected = [...parsed.rejected];
        let cursor = 0, tested = 0;
        const live = [];
        const workers = Array.from({length:Math.min(12,candidates.length)}, async () => {
          while (true) {
            const index = cursor++;
            if (index >= candidates.length) return;
            const proxy = candidates[index];
            tested++;
            try {
              const result = await testOneProxy(env, proxy);
              live.push({index, proxy, status:result.status});
            } catch (error) {
              rejected.push({proxy:`${proxy.type || "http"}://${proxy.host}:${proxy.port}`,reason:error.message});
            }
          }
        });
        await Promise.all(workers);
        live.sort((a,b)=>a.index-b.index);
        const primary = live.length ? {
          type:live[0].proxy.type, host:live[0].proxy.host,
          port:live[0].proxy.port, testStatus:live[0].status
        } : null;
        const active = live.map(({proxy:p})=>({
          type:p.type, host:p.host, port:p.port,
          username:p.username || "", password:p.password || ""
        }));
        await env.PROXY_STORE.put("active-proxies", JSON.stringify(active));
        if (primary) await setPrimaryProxy(env,primary,"initial-validation");
        else await env.PROXY_STORE.delete("primary-proxy");
        await env.PROXY_STORE.put("last-proxy-check",JSON.stringify({
          at:new Date().toISOString(),tested,total:candidates.length,
          primary:primary?`${primary.type}://${primary.host}:${primary.port}`:null,
          live:live.length,rejected:rejected.length
        }));
        proxyRotationCursor=0;
        return jsonResponse({
          ok:true, tested, total:candidates.length,
          primary:primary?`${primary.type}://${primary.host}:${primary.port}`:null,
          accepted:live.map(({proxy:p})=>`${p.type}://${p.host}:${p.port}`),
          rejected, savedCount:active.length,
          fallbackCount:Math.max(0,active.length-(primary?1:0)),
          malformedCount:parsed.rejected.length,
          message:primary
            ? `Se comprobaron todas las entradas válidas. ${active.length} proxies operativas guardadas; la primera válida queda como principal.`
            : "Se comprobaron todas las entradas válidas, pero ninguna respondió correctamente."
        });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 400);
      }
    }

    if (url.pathname === "/admin/proxies/list" && request.method === "GET") {
      if (!adminAuthorized(request, env)) return jsonResponse({ ok: false, error: "Clave de administrador incorrecta" }, 401);
      if (!env.PROXY_STORE) return jsonResponse({ ok: false, error: "Falta configurar el binding KV PROXY_STORE" }, 503);
      const saved = JSON.parse(await env.PROXY_STORE.get("active-proxies") || "[]");
      return jsonResponse({ ok: true, proxies: saved.map(p => `${p.type || "http"}://${p.host}:${p.port}`), count: saved.length });
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      let targetHost = DEFAULT_TARGET_HOST;
      try {
        targetHost = getConfig(env).targetHost;
      } catch {}

      return jsonResponse({
        ok: true,
        service: "xuper-webapp-worker-proxy",
        targetHost,
        proxyConfigured: Boolean(env.PROXY_STORE || env.PROXY_LIST || (env.PROXY_HOST && (env.PROXY_PORT_HEX || env.PROXY_PORT))),
        proxyCount: (await getActiveProxyEntries(env)).length,
        colo: request.cf?.colo || "edge"
      });
    }

    if (url.pathname === "/tools/port") {
      const value = url.searchParams.get("port");
      try {
        const decimal = decodeProxyPort(value);
        return jsonResponse({
          ok: true,
          input: value,
          decimal,
          hexadecimal: "0x" + decimal.toString(16).toUpperCase()
        });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 400);
      }
    }

    // Comprueba la IP pública que ve un servicio externo a través del proxy.
    // No devuelve usuario ni contraseña del proxy.
    if (url.pathname === "/debug/proxy") {
      try {
        const response = await fetchViaProxy(
          env,
          "https://api.ipify.org?format=json",
          { method: "GET", headers: { Accept: "application/json" } }
        );
        const result = await response.json();

        return jsonResponse({
          ok: response.ok,
          proxyExitIp: result?.ip || null,
          message: response.ok
            ? "IP de salida obtenida a través del proxy"
            : "El servicio de comprobación respondió con error"
        }, response.ok ? 200 : 502);
      } catch (error) {
        return jsonResponse({
          ok: false,
          stage: "proxy-connect-or-ip-check",
          error: error.message
        }, 502);
      }
    }

    if (url.pathname === "/session/refresh") {
      try {
        const session = await performAutoActivation(env);
        return jsonResponse({
          ok: true,
          session: {
            userId: session.userId,
            sn: session.sn,
            ts: session.ts
          }
        });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 502);
      }
    }

    if (url.pathname === "/session/fallback") {
      if (!env.SESSIONS) {
        return jsonResponse({
          ok: false,
          session: null,
          error: "No está configurado el binding KV SESSIONS"
        }, 503);
      }

      try {
        const rawList = await env.SESSIONS.get("pool:list");
        const list = rawList ? JSON.parse(rawList) : [];

        if (!list.length) {
          try {
            const newSession = await performAutoActivation(env);
            return jsonResponse({
              ok: true,
              session: {
                userId: newSession.userId,
                userToken: newSession.userToken,
                sn: newSession.sn,
                snToken: newSession.snToken
              }
            });
          } catch (activationError) {
            return jsonResponse({
              ok: false,
              session: null,
              error: activationError.message
            }, 502);
          }
        }

        for (let i = list.length - 1; i >= 0; i--) {
          const raw = await env.SESSIONS.get(`sess:${list[i]}`);
          if (!raw) continue;

          const session = JSON.parse(raw);
          if (session.userId && session.userToken) {
            return jsonResponse({
              ok: true,
              session: {
                userId: session.userId,
                userToken: session.userToken,
                sn: session.sn || "",
                snToken: session.snToken || ""
              }
            });
          }
        }

        return jsonResponse({
          ok: false,
          session: null,
          error: "No hay sesiones válidas almacenadas"
        }, 404);
      } catch (error) {
        return jsonResponse({
          ok: false,
          session: null,
          error: error.message
        }, 500);
      }
    }

    // Donación manual o automática de una sesión ya activada por fuera del
    // Worker (por ejemplo activar-xuper.mjs corriendo con IP residencial,
    // o pegada a mano desde el panel). Requiere al menos userId/userToken;
    // sn/snToken quedan vacíos si no se mandan, pero sin ellos esa sesión
    // no se va a poder renovar más adelante (ver /session/refresh).
    if (url.pathname === "/session/donate" && request.method === "POST") {
      if (!env.SESSIONS) {
        return jsonResponse({ ok: false, error: "No está configurado el binding KV SESSIONS" }, 503);
      }
      try {
        const body = await request.json();
        const userId = String(body?.userId || "").trim();
        const userToken = String(body?.userToken || "").trim();
        if (!userId || !userToken) {
          return jsonResponse({ ok: false, error: "Faltan userId y/o userToken" }, 400);
        }
        const sessionData = {
          userId,
          userToken,
          sn: String(body?.sn || ""),
          snToken: String(body?.snToken || ""),
          ts: Date.now(),
          donated: true
        };
        await saveSession(env, sessionData);
        return jsonResponse({
          ok: true,
          session: { userId: sessionData.userId, ts: sessionData.ts },
          warning: sessionData.sn && sessionData.snToken
            ? undefined
            : "Se guardó sin sn/snToken: esta sesión podrá usarse para reproducir pero no se podrá renovar."
        });
      } catch (error) {
        return jsonResponse({ ok: false, error: "Body inválido: " + error.message }, 400);
      }
    }

    // Muestra qué sesión quedaría activa ahora mismo (sin exponer tokens),
    // útil para confirmar que una donación o una renovación se guardó.
    if (url.pathname === "/session/current" && request.method === "GET") {
      const session = await getLatestSession(env);
      return jsonResponse({
        ok: Boolean(session),
        session: session ? {
          userId: session.userId,
          hasSn: Boolean(session.sn),
          hasSnToken: Boolean(session.snToken),
          donated: Boolean(session.donated),
          ageMinutes: Math.round((Date.now() - (session.ts || 0)) / 60000)
        } : null
      });
    }

    // Proxy de streams, imágenes y subtítulos.
    if (["/stream", "/img", "/sub"].includes(url.pathname)) {
      const target = url.searchParams.get("url");
      if (!target) {
        return new Response("Missing url", {
          status: 400,
          headers: cors
        });
      }

      try {
        const targetUrl = new URL(target);
        if (!["http:", "https:"].includes(targetUrl.protocol)) {
          return new Response("Only HTTP/HTTPS targets are allowed", {
            status: 400,
            headers: cors
          });
        }

        const response = await fetchContentWithFallback(env, targetUrl.toString(), {
          method: request.method === "HEAD" ? "HEAD" : "GET",
          headers: request.headers
        });

        const responseHeaders = new Headers(response.headers);
        for (const [name, value] of Object.entries(cors)) {
          responseHeaders.set(name, value);
        }

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders
        });
      } catch (error) {
        return new Response("Proxy Error: " + error.message, {
          status: 502,
          headers: cors
        });
      }
    }

    // Todas las llamadas normales a la API del portal también pasan por
    // el proxy. Ya no se usa fetch() directo a Cloudflare en esta ruta.
    try {
      const config = getConfig(env);
      const targetApiUrl =
        `https://${config.targetHost}${url.pathname}${url.search}`;

      const body = (
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) ? await request.arrayBuffer() : undefined;

      const upstream = await fetchContentWithFallback(env, targetApiUrl, {
        method: request.method,
        headers: request.headers,
        body
      });

      const upstreamHeaders = new Headers(upstream.headers);
      for (const [name, value] of Object.entries(cors)) {
        upstreamHeaders.set(name, value);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstreamHeaders
      });
    } catch (error) {
      return new Response("API Proxy Error: " + error.message, {
        status: 502,
        headers: cors
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const session = await performAutoActivation(env);
        console.log(
          "Renovación automática completada. userId:",
          session.userId
        );
      } catch (error) {
        console.error("Error en renovación automática:", error.message);
      }
    })());
  }
};
