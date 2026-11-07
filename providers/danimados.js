"use strict";
// providers/danimados.js
// Provider Nuvio para danimados.cc (WordPress con el tema DooPlay: series y caricaturas en latino).
//
// Flujo:
//   TMDB -> títulos -> página del capítulo /episodios/<serie>-<T>x<C>/
//     (si el nombre de la serie en el sitio es distinto: búsqueda /?s= y verificación por ID de TMDB,
//      porque cada página del sitio trae "tmdb: <id>" en un script)
//   -> reproductores: iframes de la página y/o opciones DooPlay (data-post/data-nume)
//      resueltas con /wp-json/dooplayer/v2/<post>/<tipo>/<nume> o admin-ajax.php
//   -> extractor según el host del embed (OK.RU, Streamwish/HGLink, archive.org, Streamtape, Playmogo).
//
// Contrato Nuvio: exports.getStreams(tmdbId, type, season, episode) -> Promise<Array<Stream>>
// (Solo Promises, sin async/await, para que corra en cualquier motor.)

var PROVIDER_NAME = "danimados";
var SITE_BASE = "https://danimados.cc";
var TMDB_API_KEY = "56db0ec297530920213e1503706b81ff";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; moto g82 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

// DEBUG: true muestra en la lista una tarjeta ⚠ con el motivo cuando no hay enlaces. Ponlo en false al terminar.
var DEBUG = true;

// Switch de sources (el orden de este objeto es el orden de salida)
var ENABLED_SOURCES = {
    Okru: true,       // ok.ru/videoembed/<id> (probado en fuegocine/pelisgo)
    Streamwish: true, // streamwish.to, hglink.to y clones (script empaquetado con hls2/hls3/hls4)
    Archive: true,    // archive.org/embed/<id>/<archivo>.mp4 -> descarga directa
    Streamtape: true, // MP4 (probado en JKAnime/flixcorn)
    Playmogo: false   // playmogo.com/e/<id>: sin probar (clon tipo Doodstream; Dsvplay no funcionó). Ponlo en true para probar.
};

var SOURCE_TIMEOUT_MS = 12000;
var FETCH_TIMEOUT_MS = 12000;

// ─────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────
function _setT(fn, ms) { try { return typeof setTimeout === "function" ? setTimeout(fn, ms) : null; } catch (_) { return null; } }
function _clrT(id) { try { if (id !== null && id !== undefined && typeof clearTimeout === "function") clearTimeout(id); } catch (_) { } }
function withTimeout(p, ms, label) {
    var timer;
    var limit = new Promise(function (_, reject) {
        timer = _setT(function () { reject(Error(label + ": tiempo agotado")); }, ms);
    });
    return Promise.race([p, limit]).then(function (r) { _clrT(timer); return r; }, function (e) { _clrT(timer); throw e; });
}
function getOrigin(url) {
    var m = String(url || "").match(/^(https?:\/\/[^\/?#]+)/i);
    return m ? m[1] : "";
}
function getHost(url) {
    return getOrigin(url).replace(/^https?:\/\//i, "").toLowerCase();
}
function stripAccents(s) {
    try { return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
    catch (_) { return String(s); }
}
function slugify(s) {
    return stripAccents(s)
        .toLowerCase()
        .replace(/['’`´]/g, "")
        .replace(/&/g, " y ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function absUrl(u, base) {
    u = String(u || "").trim().replace(/&amp;/g, "&");
    if (/^\/\//.test(u)) return "https:" + u;
    if (/^\//.test(u)) return getOrigin(base || SITE_BASE) + u;
    return u;
}
function unique(arr) {
    var out = [];
    arr.forEach(function (v) { if (v && out.indexOf(v) === -1) out.push(v); });
    return out;
}
function fetchText(url, referer, extraHeaders, opts) {
    var headers = {
        "User-Agent": UA,
        "Referer": referer || (SITE_BASE + "/"),
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8"
    };
    if (extraHeaders) for (var k in extraHeaders) headers[k] = extraHeaders[k];
    var o = { headers: headers };
    if (opts) for (var k2 in opts) o[k2] = opts[k2];
    return withTimeout(fetch(url, o).then(function (resp) {
        return resp.text().then(function (t) {
            return { ok: resp.ok, status: resp.status, url: resp.url || url, html: t };
        });
    }), FETCH_TIMEOUT_MS, "fetch " + getHost(url));
}

// ─────────────────────────────────────────────
// TMDB -> títulos
// ─────────────────────────────────────────────
function getTMDBTitles(tmdbId, type) {
    var path = type === "movie" ? "movie" : "tv";
    function fetchLang(lang) {
        var url = "https://api.themoviedb.org/3/" + path + "/" + tmdbId + "?api_key=" + TMDB_API_KEY + "&language=" + lang;
        return withTimeout(fetch(url, { headers: { "User-Agent": UA } }), FETCH_TIMEOUT_MS, "TMDB")
            .then(function (resp) { return resp.ok ? resp.json() : null; })
            .then(function (data) { return data && data.success === false ? null : data; })
            .then(null, function () { return null; });
    }
    return Promise.all([fetchLang("es-MX"), fetchLang("en-US")]).then(function (r) {
        var titles = [];
        var seen = {};
        [r[0], r[1]].forEach(function (d) {
            if (!d) return;
            [d.name, d.title, d.original_name, d.original_title].forEach(function (t) {
                if (!t) return;
                var key = slugify(t);
                if (!key || seen[key]) return;
                seen[key] = true;
                titles.push(t);
            });
        });
        return titles;
    });
}

// ─────────────────────────────────────────────
// Buscar la página del capítulo / película
// ─────────────────────────────────────────────
// Cada página del sitio trae un script con "tmdb: <id>" (ID de la serie). Sirve para confirmar que es la serie correcta.
function pageTmdb(html) {
    var m = /\btmdb\s*:\s*(\d+)/.exec(html || "");
    return m ? m[1] : null;
}
function hasPlayer(html) {
    return /data-post=|<iframe|dooplayer|player-option/i.test(html || "");
}
function episodeUrl(slug, season, episode) {
    return SITE_BASE + "/episodios/" + slug + "-" + season + "x" + episode + "/";
}
function tryEpisode(slug, season, episode, tmdbId) {
    var url = episodeUrl(slug, season, episode);
    return fetchText(url).then(function (r) {
        if (!r.ok || !hasPlayer(r.html)) return { slug: slug, status: r.status, page: null };
        var id = pageTmdb(r.html);
        return { slug: slug, status: r.status, page: { url: url, html: r.html, slug: slug }, strict: id !== null && String(id) === String(tmdbId), tmdbSeen: id };
    }, function (e) { return { slug: slug, status: e.message, page: null }; });
}
// Enlaces /series/<slug>/ o /peliculas/<slug>/ de una página de resultados de búsqueda
function parseLinks(html, kind) {
    var re = new RegExp("href=[\"'](?:https?:\\/\\/(?:www\\.)?danimados\\.cc)?\\/" + kind + "\\/([a-z0-9-]+)\\/?[\"']", "gi");
    var slugs = [];
    var m;
    while ((m = re.exec(html)) !== null) if (slugs.indexOf(m[1]) === -1) slugs.push(m[1]);
    return slugs;
}
function searchSlugs(titles, kind) {
    var terms = [];
    titles.slice(0, 4).forEach(function (t) {
        terms.push(t);
        var plain = stripAccents(t);
        if (plain !== t) terms.push(plain);
    });
    terms = unique(terms).slice(0, 6);
    return Promise.all(terms.map(function (term) {
        return fetchText(SITE_BASE + "/?s=" + encodeURIComponent(term).replace(/%20/g, "+")).then(function (r) {
            return r.ok ? parseLinks(r.html, kind) : [];
        }, function () { return []; });
    })).then(function (lists) {
        var all = [];
        lists.forEach(function (l) { all = all.concat(l); });
        return unique(all);
    });
}

function findEpisodePage(titles, tmdbId, season, episode, notes) {
    var slugs = unique(titles.map(slugify)).slice(0, 4);
    return Promise.all(slugs.map(function (s) { return tryEpisode(s, season, episode, tmdbId); })).then(function (res) {
        res.forEach(function (x) { notes.push(x.slug + ": " + (x.page ? "ok" + (x.tmdbSeen ? " tmdb " + x.tmdbSeen : "") : x.status)); });
        var strict = res.filter(function (x) { return x.page && x.strict; })[0];
        if (strict) return strict.page;
        var weakList = res.filter(function (x) { return x.page; });
        // Si la página no trae ID de TMDB (o no coincide) pero el nombre de la serie es el mismo, se usa como respaldo
        var weak = weakList[0] ? weakList[0].page : null;
        return searchSlugs(titles, "series").then(function (found) {
            var fresh = found.filter(function (s) { return slugs.indexOf(s) === -1; }).slice(0, 6);
            notes.push("búsqueda: " + (found.join(", ") || "sin resultados"));
            return Promise.all(fresh.map(function (s) { return tryEpisode(s, season, episode, tmdbId); })).then(function (res2) {
                var ok = res2.filter(function (x) { return x.page && x.strict; })[0];
                if (ok) return ok.page;
                res2.forEach(function (x) { if (x.page) notes.push(x.slug + ": tmdb " + x.tmdbSeen + " no coincide"); });
                return weak;
            });
        });
    });
}

function findMoviePage(titles, notes) {
    var direct = unique(titles.map(slugify)).slice(0, 4);
    function tryMovie(slug) {
        var url = SITE_BASE + "/peliculas/" + slug + "/";
        return fetchText(url).then(function (r) {
            return r.ok && hasPlayer(r.html) ? { url: url, html: r.html, slug: slug } : null;
        }, function () { return null; });
    }
    return Promise.all(direct.map(tryMovie)).then(function (res) {
        var f = res.filter(Boolean)[0];
        if (f) return f;
        return searchSlugs(titles, "peliculas").then(function (found) {
            notes.push("búsqueda: " + (found.join(", ") || "sin resultados"));
            var cands = found.filter(function (s) { return direct.indexOf(s) === -1; }).slice(0, 4);
            return Promise.all(cands.map(tryMovie)).then(function (r2) { return r2.filter(Boolean)[0] || null; });
        });
    });
}

// ─────────────────────────────────────────────
// Reproductores de la página
// ─────────────────────────────────────────────
function attr(tag, name) {
    var m = new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i").exec(tag);
    return m ? m[1] : "";
}
// Opciones DooPlay: <li class="dooplay_player_option" data-post="123" data-nume="1" data-type="tv">
function collectOptions(html) {
    var out = [];
    var seen = {};
    var re = /<li\b[^>]*\bdata-post=[^>]*>/gi, m;
    while ((m = re.exec(html)) !== null) {
        var tag = m[0];
        var post = attr(tag, "data-post");
        var nume = attr(tag, "data-nume");
        var type = attr(tag, "data-type") || "tv";
        if (!post || !nume) continue;
        var key = post + "/" + type + "/" + nume;
        if (seen[key]) continue;
        seen[key] = true;
        var label = html.slice(re.lastIndex, re.lastIndex + 400).split(/<\/li>/i)[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        out.push({ post: post, nume: nume, type: type, label: label });
    }
    return out;
}
function collectIframes(html, baseUrl) {
    var urls = [];
    var re = /<iframe[^>]*?\b(?:data-lazy-src|data-src|src)=["']([^"']+)["']/gi, m;
    while ((m = re.exec(html)) !== null) {
        var u = absUrl(m[1], baseUrl);
        if (/^https?:\/\//i.test(u) && urls.indexOf(u) === -1) urls.push(u);
    }
    return urls;
}
// embed_url puede ser una URL o un <iframe ...>
function embedFromValue(v, baseUrl) {
    if (!v) return null;
    v = String(v).replace(/\\\//g, "/").trim();
    var m = /(?:data-lazy-src|data-src|src)=["']([^"']+)["']/i.exec(v);
    var u = absUrl(m ? m[1] : v, baseUrl);
    return /^https?:\/\//i.test(u) ? u : null;
}
function resolveOption(opt, pageUrl) {
    var api = SITE_BASE + "/wp-json/dooplayer/v2/" + opt.post + "/" + opt.type + "/" + opt.nume;
    return fetchText(api, pageUrl, { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" }).then(function (r) {
        var d = null;
        try { d = JSON.parse(r.html); } catch (_) { }
        return embedFromValue(d && (d.embed_url || d.url), pageUrl);
    }, function () { return null; }).then(function (e) {
        if (e) return e;
        // Respaldo: admin-ajax.php (dtAjax.play_method = "admin_ajax")
        var body = "action=doo_player_ajax&post=" + encodeURIComponent(opt.post) + "&nume=" + encodeURIComponent(opt.nume) + "&type=" + encodeURIComponent(opt.type);
        return fetchText(SITE_BASE + "/wp-admin/admin-ajax.php", pageUrl, {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01"
        }, { method: "POST", body: body }).then(function (r) {
            var d = null;
            try { d = JSON.parse(r.html); } catch (_) { }
            return embedFromValue(d && (d.embed_url || d.url), pageUrl);
        }, function () { return null; });
    }).then(function (e) {
        if (!e || getHost(e).indexOf("danimados.cc") === -1) return e;
        // Algunas instalaciones devuelven una página intermedia del propio sitio (?trembed=...) con el iframe dentro
        return fetchText(e, pageUrl).then(function (r) {
            var inner = collectIframes(r.html, e).filter(function (u) { return getHost(u).indexOf("danimados.cc") === -1; })[0];
            return inner || null;
        }, function () { return null; });
    });
}
function collectEmbeds(page, notes) {
    var embeds = [];
    collectIframes(page.html, page.url).forEach(function (u) {
        if (getHost(u).indexOf("danimados.cc") === -1) embeds.push({ url: u, label: "" });
    });
    var options = collectOptions(page.html);
    notes.push("iframes en HTML: " + embeds.length + ", opciones DooPlay: " + options.length);
    return Promise.all(options.map(function (opt) {
        return resolveOption(opt, page.url).then(function (u) {
            if (!u) { notes.push("opción " + opt.nume + (opt.label ? " (" + opt.label.slice(0, 20) + ")" : "") + ": sin embed"); return null; }
            return { url: u, label: opt.label };
        });
    })).then(function (list) {
        list.forEach(function (x) { if (x) embeds.push(x); });
        var seen = {};
        return embeds.filter(function (e) { if (seen[e.url]) return false; seen[e.url] = true; return true; });
    });
}

function detectSource(url) {
    var host = getHost(url);
    if (/(^|\.)ok\.ru$|(^|\.)odnoklassniki\.ru$/.test(host)) return "Okru";
    if (/(^|\.)archive\.org$/.test(host)) return "Archive";
    if (/streamtape|tapecontent|strtape|stape|tape\./.test(host)) return "Streamtape";
    if (/playmogo/.test(host)) return "Playmogo";
    if (/wish|vidhide|filelions|hglink|dhcplay|streamhg|callistanise|dingtezuni|embedwish|swish|vidhidepro|minochinos|lulu|vibuxer|hgcloud/.test(host)) return "Streamwish";
    return null;
}

// ─────────────────────────────────────────────
// Extractores (cada uno devuelve Promise<Array<{url, headers, type?, format?, quality?, label?}>>)
// ─────────────────────────────────────────────

// OK.RU (portado de fds.js, que a su vez viene de pelisgo.js): data-options -> metadata -> videos[] / hlsManifestUrl
var OK_RES = { mobile: "144p", lowest: "240p", low: "360p", sd: "480p", hd: "720p", full: "1080p", quad: "1440p (2K)", ultra: "2160p (4K)" };
var OK_QUALITY = ["mobile", "lowest", "low", "sd", "hd", "full", "quad", "ultra"];
function okDecode(s) {
    return String(s || "").replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function parseOkru(html) {
    var m = /data-options=(["'])([\s\S]*?)\1/.exec(html);
    var meta = null;
    if (m) {
        try {
            var opts = JSON.parse(okDecode(m[2]));
            var raw = opts && opts.flashvars && opts.flashvars.metadata;
            meta = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) { /* se prueba con regex */ }
    }
    var out = [];
    if (meta) {
        var hls = meta.hlsManifestUrl || meta.hlsMasterPlaylistUrl || meta.ondemandHls;
        var vids = (meta.videos || []).filter(function (v) { return v && v.url; });
        vids.sort(function (a, b) { return OK_QUALITY.indexOf(b.name) - OK_QUALITY.indexOf(a.name); });
        var okMp4 = function (v) { return { url: v.url, format: "MP4", quality: OK_RES[v.name] || String(v.name) }; };
        if (vids[0]) out.push(okMp4(vids[0]));
        var full = vids.filter(function (v) { return v.name === "full"; })[0];
        if (vids[0] && full && vids[0] !== full) out.push(okMp4(full));
        if (hls) out.push({ url: hls, type: "hls", format: "HLS", quality: "Auto (HLS)" });
        return out;
    }
    var txt = okDecode(html).replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    var hm = /"hlsManifestUrl"\s*:\s*"([^"]+)"/.exec(txt) || /"ondemandHls"\s*:\s*"([^"]+)"/.exec(txt);
    if (hm) out.push({ url: hm[1], type: "hls", format: "HLS", quality: "Auto (HLS)" });
    return out;
}
function extractOkru(embedUrl) {
    if (embedUrl.indexOf("//") === 0) embedUrl = "https:" + embedUrl;
    return fetchText(embedUrl, SITE_BASE + "/", { "User-Agent": MOBILE_UA }).then(function (r) {
        if (!r.ok) throw Error("OK.RU: HTTP " + r.status);
        var streams = parseOkru(r.html);
        if (!streams.length) throw Error("OK.RU: no se encontró el video (" + r.html.length + " bytes)");
        return streams.map(function (v) {
            var o = { url: v.url, headers: { "Referer": "https://ok.ru/", "User-Agent": MOBILE_UA }, format: v.format, quality: v.quality };
            if (v.type) o.type = v.type;
            return o;
        });
    });
}

// Streamwish / HGLink / Vidhide / Lulustream (portado de frprpkjfjdj.js): script empaquetado con var links={"hls2":...}
var PACKED_RE = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/;
function unpackPacked(html) {
    var m = html.match(PACKED_RE);
    if (!m) return null;
    var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    var a = parseInt(m[2], 10);
    var c = parseInt(m[3], 10);
    var k = m[4].split("|");
    function e(n) {
        return (n < a ? "" : e(parseInt(n / a, 10))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    }
    var d = {};
    while (c--) d[e(c)] = k[c] || e(c);
    return p.replace(/\b\w+\b/g, function (w) { return d[w] || w; });
}
function describePage(html) {
    var t = /<title[^>]*>([^<]*)/i.exec(html || "");
    return (html || "").length + "b" +
        ", título=" + (t ? t[1].trim().slice(0, 25) : "?") +
        ", m3u8=" + (/m3u8/.test(html) ? "sí" : "no") +
        ", packer=" + (/eval\(function\(p,a,c,k,e,/.test(html) ? "sí" : "no");
}
function wishFromUrl(pageUrl) {
    // Se pide como lo haría el navegador del celular: UA móvil y Referer del sitio (el iframe vive ahí)
    return fetchText(pageUrl, SITE_BASE + "/", { "User-Agent": MOBILE_UA, "Accept-Language": "es-419,es;q=0.9" }).then(function (r) {
        var origin = getOrigin(r.url || pageUrl);
        var js = r.html;
        var unpacked = unpackPacked(r.html);
        if (unpacked) js = unpacked + "\n" + r.html;
        js = js.replace(/\\\//g, "/");
        var out = [];
        var seen = {};
        var host = getHost(origin);
        var name = /lulu/.test(host) ? "Lulustream" : (/vidhide|filelions|dingtezuni|callistanise|minochinos/.test(host) ? "Vidhide" : (/hglink|streamhg|vibuxer|dhcplay|hgcloud/.test(host) ? "StreamHG" : "Streamwish"));
        function add(label, u) {
            u = absUrl(u, origin);
            if (!/^https?:/i.test(u) || seen[u]) return;
            seen[u] = true;
            out.push({
                url: u,
                headers: { "Referer": origin + "/", "Origin": origin, "User-Agent": MOBILE_UA, "Accept": "*/*", "Accept-Language": "es-419,es;q=0.9" },
                type: "hls",
                label: name + " " + label
            });
        }
        var re = /["']?(hls\d?)["']?\s*:\s*["']([^"']+)["']/g;
        var m;
        while ((m = re.exec(js)) !== null) add(m[1], m[2]);
        if (out.length === 0) {
            var f = /file\s*:\s*["']([^"']+\.(?:m3u8|txt)[^"']*)["']/g;
            while ((m = f.exec(js)) !== null) add("hls", m[1]);
        }
        if (out.length === 0) {
            var any = /["'](https?:\/\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*|\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*)["']/g;
            while ((m = any.exec(js)) !== null) add("hls", m[1]);
        }
        if (out.length === 0) throw Error(name + ": no se encontró ningún hls (" + describePage(r.html) + ")");
        return out;
    });
}
function extractWish(embedUrl) {
    if (embedUrl.indexOf("//") === 0) embedUrl = "https:" + embedUrl;
    return wishFromUrl(embedUrl).then(null, function (e) {
        // hglink.to a veces no responde; SeriesKao lo cambia por vibuxer.com
        if (/hglink\.to/i.test(embedUrl)) return wishFromUrl(embedUrl.replace(/hglink\.to/i, "vibuxer.com")).then(null, function (e2) { throw Error(e.message + " | " + e2.message); });
        throw e;
    });
}

// archive.org: /embed/<id>/<archivo> -> /download/<id>/<archivo> (MP4 directo)
function extractArchive(embedUrl) {
    var m = /^(https?:\/\/(?:www\.)?archive\.org)\/(?:embed|details)\/([^\/?#]+)\/?([^?#]*)/i.exec(embedUrl);
    if (!m) return Promise.reject(Error("Archive: URL inválida"));
    if (!m[3]) return Promise.reject(Error("Archive: el embed no trae nombre de archivo"));
    var url = "https://archive.org/download/" + m[2] + "/" + m[3];
    var isHls = /\.m3u8(\?|$)/i.test(url);
    var o = { url: url, headers: { "User-Agent": UA, "Referer": "https://archive.org/" }, format: isHls ? "HLS" : "MP4" };
    if (isHls) o.type = "hls";
    return Promise.resolve([o]);
}

// Streamtape (portado de flixcorn/animejara): el embed arma el enlace con getElementById('robotlink'/'botlink').innerHTML
function embedId(u) {
    var clean = String(u).replace(/[?#].*$/, "");
    var m = /\/(?:e|d|v|embed)\/([A-Za-z0-9_-]+)/.exec(clean);
    return m ? m[1] : clean.replace(/\/+$/, "").split("/").pop();
}
function extractStreamtapeFromHtml(html) {
    var re = /getElementById\('(?:robotlink|botlink)'\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*(?:''\s*\+\s*)?\(\s*['"]([^'"]*)['"]\s*\)((?:\.substring\(\d+\))*)/g;
    var m, last = null;
    while ((m = re.exec(html)) !== null) last = m; // 'ideoolink' son señuelos
    if (!last) return null;
    var tail = last[2];
    (last[3].match(/\.substring\(\d+\)/g) || []).forEach(function (s) {
        tail = tail.substring(parseInt(/\d+/.exec(s)[0], 10));
    });
    var url = last[1] + tail;
    if (url.indexOf("//") === 0) url = "https:" + url;
    return url + "&stream=1";
}
function extractStreamtape(embedUrl) {
    if (embedUrl.indexOf("//") === 0) embedUrl = "https:" + embedUrl;
    var sid = embedId(embedUrl);
    var cands = unique([embedUrl, "https://streamtape.com/e/" + sid, "https://streamtape.com/v/" + sid,
        "https://streamtape.net/e/" + sid, "https://streamtape.to/e/" + sid]);
    var lastErr = null;
    function tryNext(i) {
        if (i >= cands.length) throw lastErr || Error("No se encontró el enlace en el embed de Streamtape");
        return fetchText(cands[i], SITE_BASE + "/").then(function (r) {
            var url = extractStreamtapeFromHtml(r.html);
            if (url) return [{ url: url, headers: { "Referer": "https://streamtape.com/", "User-Agent": UA }, format: "MP4" }];
            lastErr = Error("Streamtape: sin enlace en " + getHost(cands[i]));
            return tryNext(i + 1);
        }, function (e) { lastErr = e; return tryNext(i + 1); });
    }
    return tryNext(0);
}

// Playmogo (sin probar, desactivado por defecto): clon tipo Doodstream (/pass_md5/); si no, busca un enlace directo o de Streamtape en la página
function extractPlaymogo(embedUrl) {
    var origin = getOrigin(embedUrl);
    var id = embedId(embedUrl);
    var pageUrl = origin + "/e/" + id;
    return fetchText(pageUrl, SITE_BASE + "/", { "User-Agent": MOBILE_UA }).then(function (r) {
        var pm = r.html.match(/\/pass_md5\/([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)/);
        if (!pm) {
            var js = r.html.replace(/\\\//g, "/");
            var st = /https?:\/\/(?:www\.)?streamtape\.[a-z]+\/[ev]\/[A-Za-z0-9_-]+/i.exec(js);
            if (st) return extractStreamtape(st[0]);
            var g = /["'](https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)[^"'\s\\<>]*)["']/i.exec(js);
            if (g) {
                var go = { url: g[1], headers: { "Referer": origin + "/", "User-Agent": MOBILE_UA }, format: /\.m3u8/i.test(g[1]) ? "HLS" : "MP4" };
                if (/\.m3u8/i.test(g[1])) go.type = "hls";
                return [go];
            }
            throw Error("Playmogo: sin pass_md5 ni video (" + describePage(r.html) + ")");
        }
        var token = pm[1].split("/").pop();
        var ref = getOrigin(r.url || pageUrl);
        return fetchText(ref + "/pass_md5/" + pm[1], pageUrl).then(function (b) {
            var base = String(b.html).trim();
            if (!/^https?:/i.test(base)) throw Error("Playmogo: respuesta inesperada de pass_md5");
            var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            var rnd = "";
            for (var i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
            return [{ url: base + rnd + "?token=" + token + "&expiry=" + Date.now(), headers: { "Referer": ref + "/", "User-Agent": MOBILE_UA }, format: "MP4" }];
        });
    });
}

var ALL_SOURCES = {
    Okru: { label: "OK.RU", format: "MP4", extract: extractOkru },
    Streamwish: { label: "Streamwish", format: "HLS", extract: extractWish },
    Archive: { label: "Archive", format: "MP4", extract: extractArchive },
    Streamtape: { label: "Streamtape", format: "MP4", extract: extractStreamtape },
    Playmogo: { label: "Playmogo", format: "MP4", extract: extractPlaymogo }
};
var SOURCE_EXTRACTORS = {};
Object.keys(ALL_SOURCES).forEach(function (key) {
    if (ENABLED_SOURCES[key]) SOURCE_EXTRACTORS[key] = ALL_SOURCES[key];
});

// ─────────────────────────────────────────────
// Etiquetas
// ─────────────────────────────────────────────
// Todo el sitio está en "Español Latino"; solo se cambia si el nombre de la opción lo indica.
function langOf(label) {
    var l = String(label || "").toLowerCase();
    if (/sub|japon|jap\b/.test(l)) return "🌐 SUBTITULADO";
    if (/castell|espa[nñ]a|\besp\b/.test(l)) return "🇪🇸 CASTELLANO";
    return "🇲🇽 LATINO";
}

// ─────────────────────────────────────────────
// Entry point — contrato Nuvio
// ─────────────────────────────────────────────
exports.getStreams = function (tmdbId, type, season, episode) {
    if (!tmdbId || (type !== "tv" && type !== "movie")) return Promise.resolve([]);
    var isTv = type === "tv";
    var seasonNum = season ? Number(season) : 1;
    var episodeNum = episode !== undefined && episode !== null ? Number(episode) : 1;
    console.log("[" + PROVIDER_NAME + "] Buscando: TMDB " + tmdbId + " (" + type + ")" + (isTv ? " S" + seasonNum + "E" + episodeNum : ""));

    var notes = [];
    function fail(reason) {
        console.warn("[" + PROVIDER_NAME + "] " + reason);
        return DEBUG ? [{ name: PROVIDER_NAME, title: "", url: "https://example.invalid/debug", quality: "⚠ " + String(reason).slice(0, 360) }] : [];
    }

    return getTMDBTitles(tmdbId, type).then(function (titles) {
        if (!titles.length) return fail("TMDB no devolvió título (id " + tmdbId + ")");
        var finder = isTv ? findEpisodePage(titles, tmdbId, seasonNum, episodeNum, notes) : findMoviePage(titles, notes);
        return finder.then(function (page) {
            if (!page) return fail("Sin página para \"" + titles[0] + "\". " + notes.join(" | "));
            console.log("[" + PROVIDER_NAME + "] Página: " + page.url);
            return collectEmbeds(page, notes).then(function (embeds) {
                if (!embeds.length) return fail("Página sin reproductores. " + notes.join(" | "));
                var order = Object.keys(SOURCE_EXTRACTORS);
                var jobs = embeds.map(function (e) { return { e: e, key: detectSource(e.url) }; });
                var errors = [];
                jobs.forEach(function (j) {
                    if (!j.key || !SOURCE_EXTRACTORS[j.key]) errors.push(getHost(j.e.url) + " no soportado");
                });
                jobs = jobs.filter(function (j) { return j.key && SOURCE_EXTRACTORS[j.key]; });
                jobs.sort(function (a, b) { return order.indexOf(a.key) - order.indexOf(b.key); });
                return Promise.all(jobs.map(function (j) {
                    var source = SOURCE_EXTRACTORS[j.key];
                    return withTimeout(Promise.resolve().then(function () { return source.extract(j.e.url); }), SOURCE_TIMEOUT_MS, source.label).then(function (list) {
                        return list.map(function (rv) {
                            var s = {
                                name: PROVIDER_NAME,
                                title: "",
                                url: rv.url,
                                quality: "📺 " + (rv.label || source.label) + " (" + (rv.format || source.format) + ")\n" +
                                    (rv.quality || "HD") + " | WEB-DL\n" + langOf(j.e.label) +
                                    (DEBUG ? "\n🔗 " + String(rv.url).slice(0, 150) : ""),
                                headers: rv.headers
                            };
                            if (rv.type) s.type = rv.type;
                            return s;
                        });
                    }, function (err) {
                        errors.push(source.label + ": " + err.message);
                        console.warn("[" + PROVIDER_NAME + "] Falló " + source.label + ": " + err.message);
                        return [];
                    });
                })).then(function (lists) {
                    var final = [];
                    var seen = {};
                    lists.forEach(function (l) {
                        l.forEach(function (s) { if (!seen[s.url]) { seen[s.url] = true; final.push(s); } });
                    });
                    if (!final.length) return fail("Sin streams. " + errors.slice(0, 4).join(" | ") + " || " + notes.join(" | "));
                    console.log("[" + PROVIDER_NAME + "] ✓ " + final.length + " streams devueltos");
                    return final;
                });
            });
        });
    }).then(null, function (e) {
        return fail("Error: " + e.message);
    });
};
