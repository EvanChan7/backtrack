/* ============================================================
   views/dashboard.js — 总览（持有时长盈亏 + 行情/数据管理）
   ------------------------------------------------------------
   口径：平均盈亏 = 推荐日收盘 → 持有第 N 个交易日收盘的涨跌幅，
   组内等权平均。没有数据的档位显示「—」，绝不拿 0 凑数。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var quote = BT.quote;
    var store = BT.store;

    var HORIZONS = [1, 3, 5, 10];

    var syncing = false;
    var autoSyncDone = false;

    /** 全部标的（按日期 → 分组顺序） */
    function allStocks() {
        var out = [];
        Object.keys(store.state.db).forEach(function (date) {
            var batch = store.state.db[date];
            store.GROUPS.forEach(function (group) {
                var list = (batch && batch[group]) || [];
                list.forEach(function (stock) { out.push(stock); });
            });
        });
        return out;
    }

    /** 统计某分组在各持有档位上的盈亏 */
    function groupStats(groupName) {
        var total = 0;
        var buckets = {};
        HORIZONS.forEach(function (day) {
            buckets[day] = { sum: 0, n: 0, up: 0, down: 0 };
        });

        Object.keys(store.state.db).forEach(function (date) {
            var batch = store.state.db[date];
            var stocks = (batch && batch[groupName]) || [];

            stocks.forEach(function (stock) {
                total++;

                var track = Array.isArray(stock.track) ? stock.track : [];
                if (!track.length || !quote.isValidPrice(track[0])) return;

                var base = Number(track[0].price);

                HORIZONS.forEach(function (day) {
                    if (track.length <= day || !quote.isValidPrice(track[day])) return;

                    var returnPct = (Number(track[day].price) / base - 1) * 100;
                    var bucket = buckets[day];

                    bucket.sum += returnPct;
                    bucket.n++;
                    if (returnPct > 0) bucket.up++;
                    else if (returnPct < 0) bucket.down++;
                });
            });
        });

        return {
            total: total,
            days: Object.keys(store.state.db).length,
            rows: HORIZONS.map(function (day) {
                var bucket = buckets[day];
                return {
                    day: day,
                    samples: bucket.n,
                    avg: bucket.n ? bucket.sum / bucket.n : null,
                    up: bucket.up,
                    down: bucket.down
                };
            })
        };
    }

    function pnlRowHtml(row) {
        var hasData = row.samples > 0;

        return '<div class="pnl-row">'
            + '<span class="pnl-day">' + row.day + ' 天</span>'
            + '<span class="pnl-avg ' + (hasData ? quote.trendClass(row.avg) : '') + '">'
            + (hasData ? util.formatPercent(row.avg) : '—') + '</span>'
            + '<span class="pnl-split">' + (hasData ? row.up + '/' + row.down : '—') + '</span>'
            + '<span class="pnl-n">' + (hasData ? row.samples : '—') + '</span>'
            + '</div>';
    }

    function groupCardHtml(title, stats) {
        return '<div class="dash-group-card">'
            + '<div class="dash-group-title">' + title + '</div>'
            + '<div class="kpi-grid">'
            + '<div class="kpi-item"><span class="kpi-label">累计推荐</span>'
            + '<span class="kpi-val">' + stats.total + '<span class="kpi-unit"> 只</span></span></div>'
            + '<div class="kpi-item"><span class="kpi-label">回测天数</span>'
            + '<span class="kpi-val">' + stats.days + '<span class="kpi-unit"> 天</span></span></div>'
            + '</div>'
            + '<div class="section-title">持有时长盈亏</div>'
            + '<div class="pnl-table">'
            + '<div class="pnl-head"><span>持有</span><span>平均盈亏</span><span>盈/亏</span><span>样本</span></div>'
            + stats.rows.map(pnlRowHtml).join('')
            + '</div>'
            + '</div>';
    }

    function storageText() {
        var st = store.state;
        var saved = st.savedAt
            ? new Date(st.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '尚未保存修改';
        return st.backend + ' · ' + saved;
    }

    function syncLineText() {
        var stocks = allStocks();
        var ready = stocks.filter(function (s) { return s.track && s.track.length; }).length;
        if (!stocks.length) return '还没有推荐记录';
        if (syncing) return '正在同步行情…';
        if (ready === stocks.length) return '行情已同步 ' + ready + ' 只';
        return '行情已同步 ' + ready + ' / ' + stocks.length + ' 只';
    }

    function updateSyncLine(text) {
        var line = util.el('syncLine');
        if (line) line.textContent = text || syncLineText();
    }

    function syncAll(force) {
        if (syncing) return;
        var stocks = allStocks();
        if (!stocks.length) { util.showToast('还没有推荐记录'); return; }

        syncing = true;
        autoSyncDone = true;
        updateSyncLine('正在同步行情 0 / ' + Math.min(stocks.length, 60));

        BT.market.syncMany(stocks, {
            force: !!force,
            onProgress: function (stats) {
                updateSyncLine('正在同步行情 ' + stats.done + ' / ' + stats.total);
            }
        }).then(function (stats) {
            syncing = false;

            var message = stats.failed
                ? '已同步 ' + stats.ok + ' 只，' + stats.failed + ' 只暂未取到'
                : '行情已同步 ' + stats.ok + ' 只';
            if (stats.skipped) message += '（另有 ' + stats.skipped + ' 只超出单轮上限）';

            // 只刷新统计数字：重建后把滚动位置放回去
            var container = util.el('appContent');
            var top = container ? container.scrollTop : 0;
            render();
            if (container) container.scrollTop = top;

            updateSyncLine(message);
        });
    }

    function render() {
        var container = util.el('appContent');
        var warning = store.state.backend.indexOf('失败') >= 0 || store.state.backend.indexOf('不可用') >= 0;

        container.innerHTML =
            '<div class="dashboard-wrapper">'
            + groupCardHtml('优选组表现', groupStats('优选组'))
            + groupCardHtml('落选组表现', groupStats('落选组'))
            + '<div class="pnl-note pnl-note--standalone">平均盈亏＝推荐日收盘到持有第 N 个交易日收盘的涨跌幅，组内等权；'
            + '「盈/亏」为该档位上盈利与亏损的标的只数，「样本」为有足够行情可算的只数。</div>'
            + '<section class="data-tools-card">'
            + '<div class="data-tools-title">行情与数据</div>'
            + '<div class="source-row">'
            + '<span class="source-name">东方财富 · 腾讯备用</span>'
            + '<span class="source-badge">前复权日线</span>'
            + '</div>'
            + '<div class="data-tools-desc">主源异常时自动切换到备用源；请求已做限速、缓存、超时重试与分源熔断，接口全挂时显示「—」，不会用模拟数据补齐。数据仅保存在本机，不跨设备同步。</div>'
            + '<div class="storage-status' + (warning ? ' warning' : '') + '">' + util.escapeHTML(storageText()) + '</div>'
            + '<div class="sync-line" id="syncLine">' + util.escapeHTML(syncLineText()) + '</div>'
            + '<div class="risk-note">仅供个人回测记录，不构成投资建议；历史收益不代表未来表现。</div>'
            + '<div class="data-tools-actions">'
            + '<button class="data-tool-btn primary" type="button" data-action="refresh">刷新行情</button>'
            + '<button class="data-tool-btn" type="button" data-action="export">导出备份</button>'
            + '<button class="data-tool-btn" type="button" data-action="import">导入恢复</button>'
            + '</div>'
            + '</section>'
            + '</div>';

        container.querySelector('[data-action="export"]').addEventListener('click', function () {
            store.exportBackup();
        });
        container.querySelector('[data-action="import"]').addEventListener('click', function () {
            util.el('backupFileInput').click();
        });
        container.querySelector('[data-action="refresh"]').addEventListener('click', function () {
            syncAll(true);
            util.showToast('正在刷新行情');
        });

        // 进入总览后自动补一次缺失行情（每个会话只自动跑一次，避免反复打接口）
        if (!autoSyncDone && BT.market) {
            var missing = allStocks().filter(function (s) { return !s.track || !s.track.length; });
            if (missing.length) syncAll(false);
        }
    }

    BT.dashboard = { render: render, groupStats: groupStats, syncAll: syncAll };
})(window.BT);
