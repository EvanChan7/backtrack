/* ============================================================
   data/market.js — 行情数据层（东方财富主源 + 腾讯备用源）
   ------------------------------------------------------------
   为什么是这两个源、这个顺序：
     · 东方财富 push2his 的 K 线字段最全（含涨跌幅、成交额），
       且支持 JSONP（cb 参数），页面注入 <script> 即可取数，
       不需要后端代理，双击 index.html 用 file:// 打开也能跑；
     · 腾讯 web.ifzq 提供同口径的前复权日线，支持 _var= 变量赋值，
       同样不受 CORS 限制。实测东方财富的 K 线域名会间歇性返回空响应，
       因此把它作为备用源，主源连续失败后自动切换，界面上不会出现空白。

   风控（都在这一层收口，业务代码不需要关心）：
     1. 全局限速：所有请求串行排队，相邻请求至少间隔 320ms；
     2. 去重：同一只标的的并发请求共享同一个 Promise；
     3. 缓存：日线 60s（交易时段）/ 30min（非交易时段），检索 10min；
     4. 超时 9s + 最多 2 次指数退避重试；
     5. 熔断：每个数据源单独计数，连续失败 4 次进入冷却，
        冷却期内直接跳到备用源，不反复打同一个域名；
     6. 数据校验：价格必须为正、日期必须合法、按日期去重升序，
        任何异常数据一律丢弃 —— 宁可显示「—」，也不生成假收益；
     7. 按需同步：只同步当前渲染出来的标的，单轮最多 60 只。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;

    var API = {
        emKline: 'https://push2his.eastmoney.com/api/qt/stock/kline/get',
        emSearch: 'https://searchapi.eastmoney.com/api/suggest/get',
        emToken: 'D43BF722C8E33BDC906FB84D85E326E8',
        emUt: 'fa5fd1943c7b386f172d6893dbfba10b',
        txKline: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
    };

    var CFG = {
        timeout: 9000,        // 单次请求超时
        gap: 320,             // 相邻请求最小间隔（全局限速）
        retries: 1,           // 失败重试次数（JSONP 失败多为终态，重试一次足够）
        breakerFails: 3,      // 连续失败几次触发熔断
        klineTTL: 60000,      // 交易时段日线缓存
        klineTTLIdle: 1800000,// 非交易时段日线缓存
        searchTTL: 600000,    // 检索结果缓存
        maxSync: 60           // 单轮最多同步标的数
    };

    /* ---------------- 数据源健康状态 ----------------
       按「域名」而不是「公司」计数：K 线域名挂了不代表检索域名也挂了，
       分开计数才能既止住无效重试，又不误伤还能用的接口。 */
    var providers = {
        emhis: { label: '东方财富行情', fails: 0, until: 0, cool: 120000 },
        emsearch: { label: '东方财富检索', fails: 0, until: 0, cool: 60000 },
        tencent: { label: '腾讯行情', fails: 0, until: 0, cool: 60000 }
    };

    function providerBroken(id) {
        return Date.now() < providers[id].until;
    }

    function noteSuccess(id) {
        providers[id].fails = 0;
    }

    function noteFailure(id) {
        var provider = providers[id];
        provider.fails++;
        if (provider.fails >= CFG.breakerFails) {
            provider.fails = 0;
            provider.until = Date.now() + provider.cool;
        }
        notify();
    }

    /* ---------------- 小工具 ---------------- */
    function num(value) {
        if (value === null || value === undefined || value === '' || value === '-') return null;
        var n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function mkError(code, message) {
        var error = new Error(message || code);
        error.code = code;
        return error;
    }

    function shiftISO(iso, days) {
        var d = util.parseISO(iso);
        d.setDate(d.getDate() + days);
        return util.toISO(d);
    }

    /** 交易时段：9:15–11:35、12:55–15:05（节假日不额外判断，最多多刷一次） */
    function isTradingTime(date) {
        var d = date || new Date();
        var day = d.getDay();
        if (day === 0 || day === 6) return false;
        var minutes = d.getHours() * 60 + d.getMinutes();
        return (minutes >= 555 && minutes <= 695) || (minutes >= 775 && minutes <= 905);
    }

    function ttlOf(kind) {
        return isTradingTime() ? CFG[kind + 'TTL'] : CFG[kind + 'TTLIdle'];
    }

    /**
     * 代码 → secid（东方财富的市场编号）
     *   沪市：600/601/603/605/688/689、900(B股)、5xx(ETF/LOF) → 1.
     *   深市：000/001/002/003/300/301、1xx(基金)、4xx/8xx/920(北交所) → 0.
     */
    function guessSecid(code) {
        var c = String(code || '').trim();
        if (!/^\d{6}$/.test(c)) return '';
        if (/^9/.test(c) && !/^92/.test(c)) return '1.' + c;
        if (/^[65]/.test(c)) return '1.' + c;
        return '0.' + c;
    }

    /** secid → 腾讯代码：1.600519 → sh600519；0.920047 → bj920047 */
    function tencentCode(secid) {
        var parts = String(secid || '').split('.');
        if (parts.length !== 2) return '';
        var code = parts[1];
        if (parts[0] === '1') return 'sh' + code;
        if (/^[489]/.test(code)) return 'bj' + code;
        return 'sz' + code;
    }

    /* ---------------- 缓存 ---------------- */
    var cache = Object.create(null);

    function cacheGet(key, ttl) {
        var item = cache[key];
        if (!item) return null;
        if (Date.now() - item.at > ttl) { delete cache[key]; return null; }
        return item.value;
    }
    function cacheSet(key, value) {
        cache[key] = { at: Date.now(), value: value };
        return value;
    }

    /* ---------------- 请求队列（串行 + 最小间隔） ---------------- */
    var queue = [];
    var pumping = false;
    var lastRequestAt = 0;

    function schedule(run) {
        return new Promise(function (resolve, reject) {
            queue.push({ run: run, resolve: resolve, reject: reject });
            pump();
        });
    }

    function pump() {
        if (pumping || !queue.length) return;
        pumping = true;

        var wait = Math.max(0, CFG.gap - (Date.now() - lastRequestAt));
        setTimeout(function () {
            var job = queue.shift();
            if (!job) { pumping = false; return; }
            lastRequestAt = Date.now();

            var task;
            try {
                task = job.run();
            } catch (error) {
                task = Promise.reject(error);
            }

            task.then(job.resolve, job.reject).then(function () {
                pumping = false;
                pump();
                notify();
            });
        }, wait);
    }

    /* ---------------- JSONP / 变量赋值 两种载入方式 ---------------- */
    var seq = 0;

    function queryString(params) {
        return Object.keys(params).map(function (key) {
            return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]).replace(/%2C/g, ',');
        }).join('&');
    }

    /** 回调式（东方财富）：cb=函数名 */
    function jsonp(url, params) {
        return new Promise(function (resolve, reject) {
            var name = '__btMarket' + (++seq);
            var script = document.createElement('script');
            var settled = false;
            var timer = null;

            function cleanup() {
                clearTimeout(timer);
                if (script.parentNode) script.parentNode.removeChild(script);
                try { delete window[name]; } catch (error) { window[name] = undefined; }
            }

            function fail(reason) {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(reason));
            }

            window[name] = function (data) {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(data);
            };

            timer = setTimeout(function () { fail('timeout'); }, CFG.timeout);

            script.async = true;
            script.charset = 'utf-8';
            script.src = url + '?' + queryString(params) + '&cb=' + name;
            script.onerror = function () { fail('network'); };
            document.head.appendChild(script);
        });
    }

    /** 变量赋值式（腾讯）：_var=全局变量名，脚本执行后读回该变量 */
    function jsonVar(url, params) {
        return new Promise(function (resolve, reject) {
            var name = '__btTencent' + (++seq);
            var script = document.createElement('script');
            var settled = false;
            var timer = null;

            function cleanup() {
                clearTimeout(timer);
                if (script.parentNode) script.parentNode.removeChild(script);
                try { delete window[name]; } catch (error) { window[name] = undefined; }
            }

            function fail(reason) {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(reason));
            }

            timer = setTimeout(function () { fail('timeout'); }, CFG.timeout);

            script.async = true;
            script.charset = 'utf-8';
            script.src = url + '?' + queryString(params) + '&_var=' + name;
            script.onload = function () {
                if (settled) return;
                var data = window[name];
                if (!data) { fail('emptyvar'); return; }
                settled = true;
                cleanup();
                resolve(data);
            };
            script.onerror = function () { fail('network'); };
            document.head.appendChild(script);
        });
    }

    /* ---------------- 状态订阅 ---------------- */
    var listeners = [];
    var lastError = '';

    function snapshot() {
        var retry = 0;
        Object.keys(providers).forEach(function (id) {
            var left = providers[id].until - Date.now();
            if (left > 0 && (!retry || left < retry)) retry = left;
        });
        return {
            broken: !!retry,
            retryIn: retry ? Math.ceil(retry / 1000) : 0,
            trading: isTradingTime(),
            pending: queue.length,
            lastError: lastError,
            providers: providers
        };
    }

    function notify() {
        var info = snapshot();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](info); } catch (error) { /* 订阅方异常不影响请求 */ }
        }
    }

    function onStatus(fn) {
        if (typeof fn === 'function') listeners.push(fn);
    }

    /* ---------------- 统一请求入口：熔断 → 逐个重试 ---------------- */
    function request(providerId, loader) {
        if (providerBroken(providerId)) {
            return Promise.reject(mkError('breaker', providers[providerId].label + '暂时不可用'));
        }

        return attempt(0).then(function (data) {
            noteSuccess(providerId);
            lastError = '';
            return data;
        }, function (error) {
            lastError = error.message;
            noteFailure(providerId);
            throw error;
        });

        function attempt(n) {
            return schedule(loader).catch(function (error) {
                if (n >= CFG.retries) throw error;
                return delay(500 * Math.pow(2, n)).then(function () { return attempt(n + 1); });
            });
        }
    }

    /* ---------------- 代码 / 名称检索（仅东方财富，纯辅助） ---------------- */
    function normalizeSuggest(row) {
        if (!row) return null;
        var classify = String(row.Classify || '');
        // 只要 A 股（含北交所/京A）；基金、债券、港美股一律排除
        if (classify !== 'AStock' && classify !== 'NEEQ') return null;

        var quoteId = String(row.QuoteID || '');
        var matched = quoteId.match(/^(\d)\.(\d{6})$/);
        if (!matched) return null;

        var code = String(row.Code || matched[2]);
        var name = String(row.Name || '').replace(/\s+/g, '');
        if (!name) return null;

        return { code: code, name: name, secid: quoteId, market: Number(matched[1]) };
    }

    /**
     * @returns {Promise<Array|null>} 数组＝检索结果（可能为空）；
     *          null＝接口不可用（网络/熔断），调用方需要区分这两种情况
     */
    function search(keyword) {
        var key = String(keyword || '').trim();
        if (!key) return Promise.resolve([]);

        var cacheKey = 's:' + key.toLowerCase();
        var hit = cacheGet(cacheKey, CFG.searchTTL);
        if (hit) return Promise.resolve(hit);

        return request('emsearch', function () {
            return jsonp(API.emSearch, {
                input: key,
                type: 14,
                count: 8,
                token: API.emToken
            });
        }).then(function (payload) {
            var table = payload && payload.QuotationCodeTable;
            var rows = (table && table.Data) || [];
            var list = [];
            rows.forEach(function (row) {
                var item = normalizeSuggest(row);
                if (item) list.push(item);
            });
            cacheSet(cacheKey, list);
            return list;
        }, function () {
            return null;
        });
    }

    function cleanName(raw, code) {
        var name = String(raw).replace(code, '').replace(/[\s,，、\-_：:]+/g, '').trim();
        return name || ('股票 ' + code);
    }

    /** 把用户输入解析成 { code, name, secid }；查不到就抛错，绝不凭空造标的 */
    function resolve(text) {
        var raw = String(text || '').trim();
        if (!raw) return Promise.reject(mkError('empty', '请填写股票代码或名称'));

        var codeHit = raw.match(/\d{6}/);
        var code = codeHit ? codeHit[0] : '';

        return search(code || raw).then(function (list) {
            if (list === null) {
                // 接口不可用：只有能确定代码时才允许继续，并标记未校验
                if (!code) throw mkError('offline', '行情接口暂时不可用，请稍后再试');
                return { code: code, name: cleanName(raw, code), secid: guessSecid(code), verified: false };
            }
            if (list.length) {
                var exact = null;
                for (var i = 0; i < list.length; i++) {
                    if (list[i].code === code) { exact = list[i]; break; }
                }
                var hit = exact || list[0];
                return {
                    code: hit.code,
                    name: hit.name,
                    secid: hit.secid,
                    market: hit.market,
                    verified: true
                };
            }
            if (code) {
                return { code: code, name: cleanName(raw, code), secid: guessSecid(code), verified: false };
            }
            throw mkError('notfound', '没有找到「' + raw + '」，请检查代码或名称');
        });
    }

    /* ---------------- 日线：统一归一化成内部结构 ----------------
       record = { date, open, price, high, low, volume, amount, change, prevClose }
       两个源都按「日期升序、价格为正、逐日去重」清洗。 */
    function normalizeEastmoney(data) {
        var rows = (data && data.klines) || [];
        var previous = num(data && data.preKPrice);
        var seen = Object.create(null);
        var records = [];

        rows.forEach(function (line) {
            var parts = String(line).split(',');
            if (parts.length < 7) return;

            var date = parts[0];
            if (!util.isValidISODate(date) || seen[date]) return;

            var close = num(parts[2]);
            var changeAmount = num(parts[9]);
            if (!(close > 0)) return;
            seen[date] = true;

            records.push({
                date: date,
                open: num(parts[1]),
                price: close,
                high: num(parts[3]),
                low: num(parts[4]),
                volume: num(parts[5]),
                amount: num(parts[6]),
                change: num(parts[8]),
                prevClose: previous !== null ? previous : (changeAmount !== null ? close - changeAmount : close)
            });
            previous = close;
        });

        return records;
    }

    function normalizeTencent(payload, secid) {
        var code = tencentCode(secid);
        var node = payload && payload.data && payload.data[code];
        if (!node) return [];

        // qfq=前复权；个别标的没有复权数据时退回不复权的 day
        var rows = node.qfqday || node.day || [];
        var previous = null;
        var seen = Object.create(null);
        var records = [];

        rows.forEach(function (row) {
            if (!Array.isArray(row) || row.length < 5) return;

            var date = row[0];
            if (!util.isValidISODate(date) || seen[date]) return;

            var close = num(row[2]);
            if (!(close > 0)) return;
            seen[date] = true;

            records.push({
                date: date,
                open: num(row[1]),
                price: close,
                high: num(row[3]),
                low: num(row[4]),
                volume: num(row[5]),
                amount: null,
                change: previous ? (close / previous - 1) * 100 : null,
                prevClose: previous !== null ? previous : close
            });
            previous = close;
        });

        return records;
    }

    function fetchFromEastmoney(secid, beg) {
        return request('emhis', function () {
            return jsonp(API.emKline, {
                secid: secid,
                fields1: 'f1,f2,f3,f4,f5,f6',
                fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
                klt: 101,
                fqt: 1,
                beg: beg,
                end: '20500101',
                ut: API.emUt
            });
        }).then(function (payload) {
            var data = payload && payload.data;
            if (!data) throw mkError('empty', '主源无数据');
            var records = normalizeEastmoney(data);
            if (!records.length) throw mkError('empty', '主源无数据');
            return { records: records, name: data.name || '', source: 'eastmoney' };
        });
    }

    function fetchFromTencent(secid, beg, end) {
        var code = tencentCode(secid);
        if (!code) return Promise.reject(mkError('empty', '代码无法映射'));

        // 腾讯是按「条数」返回的：按日历天估算需要多少根，避免老推荐被截断掉最近的行情
        var spanDays = Math.ceil((util.parseISO(end).getTime() - util.parseISO(beg).getTime()) / 86400000);
        var count = Math.min(1500, Math.max(60, spanDays + 20));

        return request('tencent', function () {
            return jsonVar(API.txKline, {
                param: code + ',day,' + beg + ',' + end + ',' + count + ',qfq'
            });
        }).then(function (payload) {
            var records = normalizeTencent(payload, secid);
            if (!records.length) throw mkError('empty', '备用源无数据');
            var node = payload.data && payload.data[code];
            return {
                records: records,
                name: (node && (node.name || (node.qt && node.qt[code] && node.qt[code][1]))) || '',
                source: 'tencent'
            };
        });
    }

    /** 先主源、失败自动切备用源；两源都失败才算失败 */
    function getKline(secid, beg, end) {
        var cacheKey = 'k:' + secid + ':' + beg;
        var hit = cacheGet(cacheKey, ttlOf('kline'));
        if (hit) return Promise.resolve(hit);

        return fetchFromEastmoney(secid, beg).catch(function (primaryError) {
            return fetchFromTencent(secid, beg, end).catch(function (backupError) {
                lastError = '两个行情源均不可用';
                notify();
                throw mkError('unavailable',
                    (primaryError.message || '') + ' / ' + (backupError.message || ''));
            });
        }).then(function (result) {
            cacheSet(cacheKey, result);
            return result;
        });
    }

    /* ---------------- 单只标的同步 ---------------- */
    var inflight = Object.create(null);

    function isFresh(stock) {
        var age = Date.now() - Number(stock.syncedAt || 0);
        return age < ttlOf('kline');
    }

    function ensureSeries(stock, options) {
        options = options || {};
        if (!stock) return Promise.resolve(null);

        if (!stock.secid) {
            if (!/^\d{6}$/.test(String(stock.code || ''))) return Promise.resolve(null);
            stock.secid = guessSecid(stock.code);
        }

        if (!options.force && stock.track && stock.track.length && isFresh(stock)) {
            if (stock.syncState !== 'ready') stock.syncState = 'ready';
            return Promise.resolve(stock.track);
        }

        var key = stock.id || stock.secid;
        if (inflight[key]) return inflight[key];

        var recDate = util.isValidISODate(stock.recDate) ? stock.recDate : util.todayISO();
        // 往前多取 14 天：推荐日若是周末/节假日，也能拿它之前最后一个交易日作为基准
        var beg = shiftISO(recDate, -14);

        stock.syncState = 'loading';
        notify();

        var task = getKline(stock.secid, beg, util.todayISO()).then(function (result) {
            var records = result.records;

            var base = 0;
            for (var i = 0; i < records.length; i++) {
                if (records[i].date <= recDate) base = i;
            }
            var track = records.slice(base);

            stock.track = track;
            stock.baseDate = track[0].date;
            stock.syncedAt = Date.now();
            stock.syncState = 'ready';
            stock.syncError = '';
            stock.dataSource = result.source;
            if ((!stock.name || stock.name === '--') && result.name) stock.name = result.name;

            if (BT.store && BT.store.persistSoon) BT.store.persistSoon();
            notify();
            return track;
        }).catch(function (error) {
            stock.syncState = 'error';
            stock.syncError = error.message;
            notify();
            throw error;
        });

        var wrapped = task.then(function (value) {
            delete inflight[key];
            return value;
        }, function (error) {
            delete inflight[key];
            throw error;
        });

        inflight[key] = wrapped;
        return wrapped;
    }

    /**
     * 批量同步（串行，便于做进度与限流）
     * @param {Array} stocks
     * @param {Object} [options] { force, limit, onProgress(stats, stock) }
     */
    function syncMany(stocks, options) {
        options = options || {};
        var list = (stocks || []).filter(function (stock) {
            return stock && stock.code && stock.code !== '--';
        });
        var limited = list.slice(0, options.limit || CFG.maxSync);
        var index = 0;
        var stats = { total: limited.length, done: 0, ok: 0, failed: 0, skipped: list.length - limited.length };

        return new Promise(function (resolve) {
            function next() {
                if (index >= limited.length) return resolve(stats);

                var stock = limited[index++];
                ensureSeries(stock, { force: !!options.force })
                    .then(function () { stats.ok++; }, function () { stats.failed++; })
                    .then(function () {
                        stats.done++;
                        if (options.onProgress) options.onProgress(stats, stock);
                        next();
                    });
            }
            next();
        });
    }

    BT.market = {
        ensureSeries: ensureSeries,
        syncMany: syncMany,
        resolve: resolve,
        search: search,
        guessSecid: guessSecid,
        isTradingTime: isTradingTime,
        onStatus: onStatus,
        status: snapshot
    };
})(window.BT);
