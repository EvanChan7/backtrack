/* ============================================================
   views/dashboard.js — 总览（胜率统计 + 行情/数据管理）
   ------------------------------------------------------------
   胜率全部基于真实行情轨道计算：D1 用第二天涨跌，D3/D5 用当日收盘比。
   没有数据的标的计入「累计推荐」，但不计入胜率分母 —— 不拿缺失值凑数。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var quote = BT.quote;
    var store = BT.store;

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

    /** 统计某分组在全部批次上的表现 */
    function groupStats(groupName) {
        var total = 0;
        var win = { 1: 0, 3: 0, 5: 0 };
        var denom = { 1: 0, 3: 0, 5: 0 };

        Object.keys(store.state.db).forEach(function (date) {
            var batch = store.state.db[date];
            var stocks = (batch && batch[groupName]) || [];

            stocks.forEach(function (stock) {
                total++;
                var track = Array.isArray(stock.track) ? stock.track : [];

                var d1 = track.length > 1 ? quote.dailyChange(track[1]) : null;
                if (d1 !== null) { denom[1]++; if (d1 > 0) win[1]++; }

                if (track.length > 3 && quote.isValidPrice(track[0]) && quote.isValidPrice(track[3])) {
                    denom[3]++;
                    if (Number(track[3].price) > Number(track[0].price)) win[3]++;
                }
                if (track.length > 5 && quote.isValidPrice(track[0]) && quote.isValidPrice(track[5])) {
                    denom[5]++;
                    if (Number(track[5].price) > Number(track[0].price)) win[5]++;
                }
            });
        });

        var rate = function (day) {
            return denom[day] ? Math.round(win[day] / denom[day] * 100) : null;
        };

        return {
            total: total,
            days: Object.keys(store.state.db).length,
            rateD1: rate(1),
            rateD3: rate(3),
            rateD5: rate(5)
        };
    }

    function winRateRow(label, rate) {
        var width = rate === null ? 0 : rate;
        return '<div class="wr-bar-row">'
            + '<span class="wr-label">' + label + '</span>'
            + '<div class="wr-track"><div class="wr-fill" style="width:' + width + '%"></div></div>'
            + '<span class="wr-val">' + (rate === null ? '—' : rate + '%') + '</span>'
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
            + '<div class="section-title">持有时长胜率</div>'
            + winRateRow('Day 1', stats.rateD1)
            + winRateRow('Day 3', stats.rateD3)
            + winRateRow('Day 5', stats.rateD5)
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
