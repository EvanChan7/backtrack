/* ============================================================
   views/feed.js — 每日批次流（无限滚动）
   只负责「把数据渲染成列表」，点击行的事件通过委托交给 drawer。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var quote = BT.quote;
    var store = BT.store;

    var PAGE_SIZE = 5;

    var cursor = 0;        // 下一条待渲染的日期索引
    var loading = false;
    var hasMore = true;
    var observer = null;
    var syncing = Object.create(null);   // stockId -> true，避免重复排队

    function scroller() { return util.el('appContent'); }

    /* ---------------- 列表骨架 ---------------- */
    function renderShell() {
        scroller().innerHTML =
            '<div id="feedList"></div>' +
            '<div id="feedSentinel" class="feed-sentinel"></div>' +
            '<div class="loading-more" id="loadingIndicator" hidden>已到最早记录</div>';
    }

    /* ---------------- 行情状态文案 ----------------
       拿不到数据时只显示「—」和原因，绝不编造数字。 */
    function metaText(stock, metrics) {
        var code = util.escapeHTML(stock.code || '--');
        if (metrics.validCount) return code + ' · 追踪 ' + metrics.daysTracked + ' 天';
        if (stock.syncState === 'loading') return code + ' · 同步行情中';
        if (stock.syncState === 'error') return code + ' · 行情暂未取到';
        return code + ' · 待同步';
    }

    /* ---------------- 单行 ---------------- */
    function rowHtml(stock, groupName, date) {
        var m = quote.returnsOf(stock);
        var todayClass = quote.trendClass(m.today);
        var cumulativeClass = quote.trendClass(m.cumulative);
        var spark = BT.sparkline.render(stock.track, stock.id);

        return '<div class="stock-row" role="button" tabindex="0"'
            + ' data-date="' + util.escapeHTML(date) + '"'
            + ' data-group="' + util.escapeHTML(groupName) + '"'
            + ' data-stock="' + util.escapeHTML(stock.id) + '"'
            + ' aria-label="查看 ' + util.escapeHTML(stock.name || '未命名标的') + ' 详情">'
            + '<div class="stock-info">'
            + '<div class="stock-name">' + util.escapeHTML(stock.name || '未命名标的') + '</div>'
            + '<div class="stock-meta">' + metaText(stock, m) + '</div>'
            + '</div>'
            + '<div class="track-summary">'
            + (spark || '<span class="chart-placeholder" aria-hidden="true"></span>')
            + '<div class="performance">'
            + '<div class="perf-cell">'
            + '<span class="perf-val ' + todayClass + '">' + util.formatPercent(m.today) + '</span>'
            + '<span class="perf-label">今日</span></div>'
            + '<div class="perf-cell">'
            + '<span class="perf-val ' + cumulativeClass + '">' + util.formatPercent(m.cumulative) + '</span>'
            + '<span class="perf-label">累计</span></div>'
            + '</div>'
            + '</div>'
            + '</div>';
    }

    /* ---------------- 组内汇总 ----------------
       百分比相加没有意义，所以用「等权平均」：组内所有拿到行情的标的算术平均。
       没有数据的组返回 null，页面上显示「—」，绝不拿 0 冒充。 */
    function groupAggregate(stocks) {
        var todaySum = 0;
        var todayCount = 0;
        var cumSum = 0;
        var cumCount = 0;

        stocks.forEach(function (stock) {
            var m = quote.returnsOf(stock);
            if (m.today !== null) { todaySum += m.today; todayCount++; }
            if (m.cumulative !== null) { cumSum += m.cumulative; cumCount++; }
        });

        return {
            today: todayCount ? todaySum / todayCount : null,
            cumulative: cumCount ? cumSum / cumCount : null
        };
    }

    /** 与行内 perf-cell 完全同构，靠 CSS 的 --perf-col 完成列对齐 */
    function perfCell(value, label) {
        return '<div class="perf-cell">'
            + '<span class="perf-val ' + quote.trendClass(value) + '">' + util.formatPercent(value) + '</span>'
            + '<span class="perf-label">' + label + '</span>'
            + '</div>';
    }

    /* ---------------- 单个批次 ---------------- */
    function batchHtml(date, collector) {
        var batch = store.state.db[date] || { '优选组': [], '落选组': [] };
        var html = '<div class="feed-batch">';
        html += '<div class="batch-date-divider">' + util.escapeHTML(date) + '</div>';

        store.GROUPS.forEach(function (groupName) {
            var stocks = Array.isArray(batch[groupName]) ? batch[groupName] : [];
            if (collector) stocks.forEach(function (stock) { collector.push(stock); });

            var agg = groupAggregate(stocks);

            html += '<div class="group-block" data-group="' + util.escapeHTML(groupName) + '">'
                + '<div class="group-header">'
                + '<div class="group-heading">'
                + '<span class="group-name">' + groupName + '</span>'
                + '<span class="group-count" aria-label="' + stocks.length + ' 只标的">' + stocks.length + '</span>'
                + '</div>'
                + '<div class="group-perf" aria-label="组内平均">'
                + perfCell(agg.today, '今日')
                + perfCell(agg.cumulative, '累计')
                + '</div>'
                + '</div>'
                + (stocks.length
                    ? stocks.map(function (s) { return rowHtml(s, groupName, date); }).join('')
                    : '<div class="empty-state">暂无推荐标的</div>')
                + '</div>';
        });

        return html + '</div>';
    }

    /* ---------------- 行情同步 ----------------
       只同步「当前已渲染」的标的，不预取、不轮询。
       所有请求在 market 层串行限速，这里只负责把结果贴回对应的行。 */
    function syncStocks(stocks) {
        if (!BT.market || !stocks || !stocks.length) return;

        stocks.forEach(function (stock) {
            if (!stock || !stock.code || stock.code === '--') return;
            if (syncing[stock.id]) return;

            syncing[stock.id] = true;
            BT.market.ensureSeries(stock).then(function () {
                updateRow(stock);
            }, function () {
                updateRow(stock);
            }).then(function () {
                delete syncing[stock.id];
            });
        });
    }

    /** 行情回填后重算组级汇总（否则组头的平均收益会停留在同步前的状态） */
    function refreshGroupHeader(block) {
        if (!block) return;
        var group = block.dataset.group;
        var stocks = [];

        Array.prototype.forEach.call(block.querySelectorAll('.stock-row'), function (row) {
            var found = store.findStock(row.dataset.date, group, row.dataset.stock);
            if (found) stocks.push(found);
        });

        var perf = block.querySelector('.group-perf');
        if (!perf) return;

        var agg = groupAggregate(stocks);
        perf.innerHTML = perfCell(agg.today, '今日') + perfCell(agg.cumulative, '累计');
    }

    /** 局部替换某只标的所在行，避免整列表重渲染导致滚动跳动 */
    function updateRow(stock) {
        if (!stock) return;
        var rows = scroller().querySelectorAll('.stock-row');
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].dataset.stock !== stock.id) continue;

            var block = rows[i].closest('.group-block');
            var holder = document.createElement('div');
            holder.innerHTML = rowHtml(stock, rows[i].dataset.group, rows[i].dataset.date);
            rows[i].parentNode.replaceChild(holder.firstElementChild, rows[i]);
            refreshGroupHeader(block);
            return;
        }
    }

    /* ---------------- 分页渲染 ---------------- */
    function appendPage() {
        if (loading || !hasMore) return;

        var list = util.el('feedList');
        var indicator = util.el('loadingIndicator');
        if (!list || !indicator) return;

        var dates = store.state.dates;
        loading = true;

        var html = '';
        var pageStocks = [];
        for (var i = 0; i < PAGE_SIZE; i++) {
            if (cursor >= dates.length) { hasMore = false; break; }
            html += batchHtml(dates[cursor], pageStocks);
            cursor++;
        }
        if (html) list.insertAdjacentHTML('beforeend', html);
        if (cursor >= dates.length) hasMore = false;

        loading = false;

        // 渲染完再同步行情：先把结构铺好，数据到了逐行贴回去
        syncStocks(pageStocks);

        if (!hasMore) {
            indicator.textContent = '已到最早记录';
            indicator.hidden = false;
            disconnectObserver();
        } else {
            // 还有更早的批次时不显示提示条，滚动到底部会自动续载
            indicator.hidden = true;
            observeSentinel();
        }
    }

    /* ---------------- 哨兵观察 ---------------- */
    function disconnectObserver() {
        if (observer) { observer.disconnect(); observer = null; }
    }

    function observeSentinel() {
        disconnectObserver();
        var sentinel = util.el('feedSentinel');
        if (!sentinel) return;

        observer = new IntersectionObserver(function (entries) {
            if (entries[0].isIntersecting && !loading && hasMore && store.state.tab === 'batch') {
                appendPage();
            }
        }, { root: scroller(), threshold: 0.1 });
        observer.observe(sentinel);
    }

    /* ---------------- 对外接口 ---------------- */
    /** 从指定日期开始重新渲染（用于切换日期 / 切回每日 Tab） */
    function resetTo(date) {
        disconnectObserver();
        loading = false;
        renderShell();

        var dates = store.state.dates;
        if (!dates.length) {
            var list = util.el('feedList');
            if (list) {
                list.innerHTML = '<div class="empty-card">'
                    + '<div class="empty-title">还没有推荐记录</div>'
                    + '<div class="empty-desc">点右下角 + 录入第一条，行情会自动同步并计算收益</div>'
                    + '</div>';
            }
            hasMore = false;
            cursor = 0;
            return;
        }

        var index = dates.indexOf(date);
        cursor = index > 0 ? index : 0;
        hasMore = cursor < dates.length;

        appendPage();
    }

    function teardown() {
        disconnectObserver();
        loading = false;
        cursor = 0;
        hasMore = true;
    }

    /** 绑定一次行点击/键盘事件（事件委托，避免每行挂 onclick） */
    function bindEvents() {
        var container = scroller();

        container.addEventListener('click', function (event) {
            var row = event.target.closest('.stock-row');
            if (!row) return;
            BT.drawer.open(row.dataset.date, row.dataset.group, row.dataset.stock);
        });

        container.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            var row = event.target.closest('.stock-row');
            if (!row) return;
            event.preventDefault();
            BT.drawer.open(row.dataset.date, row.dataset.group, row.dataset.stock);
        });
    }

    /* ---------------- 定时刷新 ----------------
       页面开着不动时行情不会自己变，所以按固定间隔重拉当前列表。
       只刷「已经渲染出来的行」，不预取、不动滚动位置。 */
    var refreshing = false;

    function refreshVisible() {
        if (refreshing || !BT.market) return Promise.resolve();

        var stocks = [];
        Array.prototype.forEach.call(scroller().querySelectorAll('.stock-row'), function (row) {
            var found = store.findStock(row.dataset.date, row.dataset.group, row.dataset.stock);
            if (found) stocks.push(found);
        });
        if (!stocks.length) return Promise.resolve();

        refreshing = true;
        return BT.market.syncMany(stocks, {
            force: true,
            onProgress: function (stats, stock) { updateRow(stock); }
        }).then(function () {
            refreshing = false;
        }, function () {
            refreshing = false;
        });
    }

    BT.feed = {
        resetTo: resetTo,
        teardown: teardown,
        updateRow: updateRow,
        refreshVisible: refreshVisible,
        bindEvents: bindEvents
    };
})(window.BT);
