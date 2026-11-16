/* ============================================================
   data/store.js — 数据仓库 + 本机持久化 + 备份导入导出
   ------------------------------------------------------------
   存储策略（保持与旧版本 key 一致，升级不丢数据）：
     1) 首选 IndexedDB（容量大、异步）
     2) 受限环境（file:// / 隐私模式）退回 localStorage
     3) 都失败时明确提示，引导用户导出 JSON 备份
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;

    var GROUPS = ['优选组', '落选组'];

    var IDB_NAME = 'model-backtest-center';
    var IDB_STORE = 'snapshots';
    var IDB_KEY = 'main';
    /* v3：接入真实行情，数据里多了 secid / track / syncedAt。
       v2 及更早的快照全部视为「旧版演示数据」丢弃，
       避免自动生成的假行情被当成真实回测结果继续展示。 */
    var VERSION = 3;
    var LS_FULL = 'model-backtest-center-backup-v3';
    var LS_DELTA = 'model-backtest-center-delta-v3';

    var state = {
        db: {},
        dates: [],
        selectedDate: '',
        tab: 'batch',        // 'batch' | 'dashboard'
        savedAt: null,
        backend: '尚未保存',
        legacyCleared: false // 是否丢弃过旧版演示数据（用于首次提示）
    };

    /** localStorage 里尚未合并进主库的增量记录 */
    var pendingRecords = [];
    var backupPending = false;

    /* ---------------- 校验 ---------------- */
    function validDatabase(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        var seen = new Set();
        return Object.keys(value).every(function (date) {
            var batch = value[date];
            if (!util.isValidISODate(date) || !batch || typeof batch !== 'object' || Array.isArray(batch)) return false;
            return GROUPS.every(function (group) {
                var list = batch[group];
                return Array.isArray(list) && list.every(function (stock) {
                    if (!stock || typeof stock !== 'object' || Array.isArray(stock)) return false;
                    if (typeof stock.id !== 'string' || !stock.id.trim()) return false;
                    if (!Array.isArray(stock.track)) return false;
                    if (seen.has(stock.id)) return false;
                    seen.add(stock.id);
                    return true;
                });
            });
        });
    }

    /* ---------------- IndexedDB ---------------- */
    function openIndexedDB() {
        return new Promise(function (resolve, reject) {
            if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
            var request = indexedDB.open(IDB_NAME, 1);
            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('IndexedDB open failed')); };
            request.onblocked = function () { reject(new Error('IndexedDB blocked')); };
        });
    }

    function readSnapshot() {
        return openIndexedDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, 'readonly');
                var req = tx.objectStore(IDB_STORE).get(IDB_KEY);
                req.onsuccess = function () { var v = req.result; db.close(); resolve(v || null); };
                req.onerror = function () { db.close(); reject(req.error); };
            });
        });
    }

    function writeSnapshot(snapshot) {
        return openIndexedDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(snapshot, IDB_KEY);
                tx.oncomplete = function () { db.close(); resolve(); };
                tx.onerror = function () { db.close(); reject(tx.error || new Error('IndexedDB write failed')); };
                tx.onabort = function () { db.close(); reject(tx.error || new Error('IndexedDB write aborted')); };
            });
        });
    }

    /* ---------------- 读取 ---------------- */
    function loadFromIndexedDB() {
        return readSnapshot().then(function (snapshot) {
            if (!snapshot) return false;
            if (snapshot.version !== VERSION) {
                state.legacyCleared = true;
                return false;
            }
            if (!validDatabase(snapshot.data)) {
                state.legacyCleared = true;
                return false;
            }
            state.db = snapshot.data;
            state.savedAt = snapshot.updatedAt || null;
            state.backend = '本机自动保存';
            return true;
        }).catch(function () { return false; });
    }

    function loadFromLocalStorage() {
        try {
            var fullRaw = localStorage.getItem(LS_FULL);
            if (fullRaw) {
                var full = JSON.parse(fullRaw);
                if (full && full.version === VERSION && validDatabase(full.data)) {
                    state.db = full.data;
                    state.savedAt = full.updatedAt || null;
                    state.backend = '本机备用存储';
                } else {
                    state.legacyCleared = true;
                }
            }
            var deltaRaw = localStorage.getItem(LS_DELTA);
            if (deltaRaw) {
                var delta = JSON.parse(deltaRaw);
                if (delta && delta.version === VERSION && Array.isArray(delta.records)) {
                    pendingRecords = delta.records.filter(function (item) {
                        return item && util.isValidISODate(item.date)
                            && GROUPS.indexOf(item.group) >= 0
                            && item.stock && typeof item.stock.id === 'string'
                            && item.stock.id.trim() && Array.isArray(item.stock.track);
                    });
                    state.savedAt = delta.updatedAt || state.savedAt;
                    if (pendingRecords.length) state.backend = '本机备用存储（新增记录）';
                }
            }
        } catch (error) {
            state.backend = '暂不可用';
        }
    }

    /* ---------------- 写入 ----------------
       所有写入串成一条链：行情同步可能连续更新多只标的，
       如果并发写 IndexedDB，最后一次写不一定是最新快照。 */
    var persistChain = Promise.resolve();
    var persistTimer = null;

    function persist(showFeedback) {
        var job = persistChain.then(function () { return writeAll(showFeedback); });
        persistChain = job.catch(function () { /* 失败已在 writeAll 内提示 */ });
        return job;
    }

    /** 行情同步后的兜底保存：合并短时间内的多次变更，避免频繁写盘 */
    function persistSoon(delayMs) {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(function () {
            persist(false);
        }, delayMs || 900);
    }

    function writeAll(showFeedback) {
        var snapshot = { version: VERSION, updatedAt: new Date().toISOString(), data: state.db };

        return writeSnapshot(snapshot).then(function () {
            state.backend = '本机自动保存';
            state.savedAt = snapshot.updatedAt;
            pendingRecords = [];
            backupPending = false;
            if (showFeedback) util.showToast('已保存到本机');
            return true;
        }).catch(function () {
            // IndexedDB 不可用：退回 localStorage
            try {
                if (backupPending) {
                    var serialized = JSON.stringify(snapshot);
                    if (serialized.length > 4 * 1000 * 1000) throw new Error('备份数据超过浏览器备用存储容量');
                    localStorage.setItem(LS_FULL, serialized);
                    localStorage.removeItem(LS_DELTA);
                    state.backend = '本机备用存储';
                    backupPending = false;
                } else {
                    var delta = { version: VERSION, updatedAt: snapshot.updatedAt, records: pendingRecords };
                    localStorage.setItem(LS_DELTA, JSON.stringify(delta));
                    state.backend = '本机备用存储（新增记录）';
                }
                state.savedAt = snapshot.updatedAt;
                if (showFeedback) util.showToast('已保存到本机备用空间');
                return true;
            } catch (error) {
                state.backend = '保存失败，请导出备份';
                util.showToast('本机存储空间不足，请立即导出备份');
                return false;
            }
        });
    }

    /* ---------------- 索引与选中 ---------------- */
    function refreshDates() {
        state.dates = Object.keys(state.db).sort(function (a, b) { return b.localeCompare(a); });
        if (state.dates.indexOf(state.selectedDate) < 0) {
            state.selectedDate = state.dates[0] || util.todayISO();
        }
    }

    function setSelectedDate(date) {
        if (!date) return;
        state.selectedDate = date;
    }

    function setTab(tab) {
        if (tab !== 'batch' && tab !== 'dashboard') return;
        state.tab = tab;
    }

    /* ---------------- 领域操作 ---------------- */
    function ensureBatch(date) {
        if (!state.db[date]) state.db[date] = { '优选组': [], '落选组': [] };
        GROUPS.forEach(function (group) {
            if (!Array.isArray(state.db[date][group])) state.db[date][group] = [];
        });
        return state.db[date];
    }

    function findStock(date, group, stockId) {
        var batch = state.db[date];
        if (!batch || !Array.isArray(batch[group])) return null;
        for (var i = 0; i < batch[group].length; i++) {
            if (batch[group][i].id === stockId) return batch[group][i];
        }
        return null;
    }

    /** 判断同一天同一分组里是否已有该标的（按代码优先、其次名称） */
    function hasDuplicate(date, group, code, name) {
        var list = (state.db[date] && state.db[date][group]) || [];
        /* code 为 '--' 时不能当有效代码用，否则两边都算成「code:--」，同名不同股会互相误判 */
        var validCode = code && code !== '--';
        var key = validCode ? 'code:' + code : 'name:' + String(name || '').toLowerCase();
        return list.some(function (item) {
            var itemKey = item.code && item.code !== '--'
                ? 'code:' + item.code
                : 'name:' + String(item.name || '').toLowerCase();
            return itemKey === key;
        });
    }

    function addStock(date, group, stock) {
        ensureBatch(date)[group].unshift(stock);
        pendingRecords.push({ date: date, group: group, stock: stock });
        refreshDates();
        return stock;
    }

    /** 按 id 反查标的所在的日期与分组（详情页只拿得到 id） */
    function locateStock(stockId) {
        var dates = Object.keys(state.db);
        for (var i = 0; i < dates.length; i++) {
            var batch = state.db[dates[i]];
            for (var g = 0; g < GROUPS.length; g++) {
                var list = batch[GROUPS[g]] || [];
                for (var j = 0; j < list.length; j++) {
                    if (list[j].id === stockId) {
                        return { date: dates[i], group: GROUPS[g], index: j, stock: list[j] };
                    }
                }
            }
        }
        return null;
    }

    /** 删除后如果这一天两个分组都空了，把整天的批次一起清掉，避免留下空壳日期 */
    function dropDateIfEmpty(date) {
        var batch = state.db[date];
        if (!batch) return;
        var empty = GROUPS.every(function (group) {
            return !(batch[group] || []).length;
        });
        if (empty) delete state.db[date];
    }

    /** 删除一只标的。返回 true 表示确实删掉了 */
    function removeStock(stockId) {
        var found = locateStock(stockId);
        if (!found) return false;

        state.db[found.date][found.group].splice(found.index, 1);
        dropDateIfEmpty(found.date);
        // 增量记录里也要摘掉，否则 IndexedDB 写失败走 localStorage 降级时
        // 这条已删除的记录会在下次启动被重新合并回来
        pendingRecords = pendingRecords.filter(function (item) {
            return !item.stock || item.stock.id !== stockId;
        });
        refreshDates();
        return true;
    }

    /**
     * 改推荐日：把标的从旧批次整体挪到新日期批次。
     * track 必须清空 —— 日期一换，原来那串行情就不再对应新的 D0，
     * 留着会被当成「新日期下的收益」展示，那是错的。
     * 返回 null 表示失败或目标日期已有同一只标的。
     */
    function moveStockToDate(stockId, toDate) {
        var found = locateStock(stockId);
        if (!found || !util.isValidISODate(toDate)) return null;
        if (found.date === toDate) return { stock: found.stock, group: found.group, moved: false };

        if (hasDuplicate(toDate, found.group, found.stock.code, found.stock.name)) return null;

        state.db[found.date][found.group].splice(found.index, 1);
        dropDateIfEmpty(found.date);

        var stock = found.stock;
        stock.recDate = toDate;
        stock.track = [];
        stock.baseDate = '';
        stock.syncedAt = 0;
        stock.syncState = 'idle';
        stock.syncError = '';

        ensureBatch(toDate)[found.group].unshift(stock);
        retargetPending(stock.id, toDate, found.group);
        refreshDates();
        return { stock: stock, group: found.group, moved: true };
    }

    /**
     * 改组别：同一天内把标的在优选组 / 落选组之间挪动。
     * track 保留 —— 日期没变，基准价和行情序列都还有效，收益口径不受影响。
     * 返回 null 表示目标分组里已经有同一只标的。
     */
    function moveStockToGroup(stockId, toGroup) {
        var found = locateStock(stockId);
        if (!found || GROUPS.indexOf(toGroup) < 0) return null;
        if (found.group === toGroup) return { stock: found.stock, group: found.group, moved: false };

        if (hasDuplicate(found.date, toGroup, found.stock.code, found.stock.name)) return null;

        state.db[found.date][found.group].splice(found.index, 1);
        ensureBatch(found.date)[toGroup].unshift(found.stock);
        retargetPending(stockId, found.date, toGroup);
        refreshDates();
        return { stock: found.stock, group: toGroup, moved: true };
    }

    /** 增量记录里同步改指向，否则降级到 localStorage 时会被搬回旧位置 */
    function retargetPending(stockId, date, group) {
        pendingRecords.forEach(function (item) {
            if (!item.stock || item.stock.id !== stockId) return;
            item.date = date;
            item.group = group;
        });
    }

    /* ---------------- 备份 ---------------- */
    function exportBackup() {
        var payload = {
            app: 'BackTrack',
            version: VERSION,
            exportedAt: new Date().toISOString(),
            data: state.db
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'BackTrack-备份-' + util.todayISO() + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        util.showToast('备份文件已导出');
    }

    function importBackup(file) {
        if (!file) return Promise.resolve(false);

        return Promise.resolve()
            .then(function () {
                if (file.size > 25 * 1024 * 1024) throw new Error('备份文件超过 25MB，请确认文件是否正确');
                return file.text();
            })
            .then(function (text) {
                var payload = JSON.parse(text);
                var incoming = payload && payload.data;
                if (!validDatabase(incoming)) throw new Error('文件结构不正确或版本不兼容');
                if (!window.confirm('导入将替换当前本机数据。建议先导出当前备份，确定继续吗？')) return false;

                state.db = incoming;
                pendingRecords = [];
                backupPending = true;
                refreshDates();
                state.selectedDate = state.dates[0] || util.todayISO();
                state.tab = 'batch';

                return persist(false).then(function (ok) {
                    util.showToast(ok
                        ? '数据已恢复并保存'
                        : '数据已载入当前页面，但本机保存失败，请另存备份');
                    return true;
                });
            })
            .catch(function (error) {
                util.showToast('导入失败：' + (error.message || '文件无法读取'));
                return false;
            });
    }

    /* ---------------- 初始化 ---------------- */
    function init() {
        return loadFromIndexedDB().then(function (loaded) {
            if (!loaded) loadFromLocalStorage();

            // 从 v3 起不再内置任何演示数据：空库就是空库，绝不伪造收益
            if (state.legacyCleared) {
                // 用空库覆盖旧版演示快照，避免每次启动都重复提示
                writeAll(false);
            }

            // 合并 localStorage 里的增量记录
            pendingRecords.forEach(function (item) {
                ensureBatch(item.date);
                var list = state.db[item.date][item.group];
                var exists = list.some(function (s) { return s.id === item.stock.id; });
                if (!exists) list.unshift(item.stock);
            });

            refreshDates();
            state.selectedDate = state.dates[0] || util.todayISO();
            return state;
        });
    }

    BT.store = {
        GROUPS: GROUPS,
        state: state,
        init: init,
        refreshDates: refreshDates,
        setSelectedDate: setSelectedDate,
        setTab: setTab,
        persist: persist,
        persistSoon: persistSoon,
        ensureBatch: ensureBatch,
        findStock: findStock,
        hasDuplicate: hasDuplicate,
        addStock: addStock,
        locateStock: locateStock,
        removeStock: removeStock,
        moveStockToDate: moveStockToDate,
        moveStockToGroup: moveStockToGroup,
        exportBackup: exportBackup,
        importBackup: importBackup
    };
})(window.BT);
