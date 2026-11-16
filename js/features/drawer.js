/* ============================================================
   features/drawer.js — 个股详情抽屉
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var quote = BT.quote;
    var store = BT.store;

    var overlay = null;
    var drawer = null;
    var bound = false;
    var openToken = 0;

    /**
     * 相对基准价（推荐日收盘 = 买入价）的收益率。
     * 详情页只谈百分比不谈价格：这条记录让用户赚了多少个点，才是要复盘的东西。
     */
    function pctFrom(value, base) {
        if (!util.isNum(value) || !base || !(base > 0)) return null;
        return (Number(value) / base - 1) * 100;
    }

    /** 基准价取推荐日收盘；该槽位缺失时退回第一个有效价格，保证 D0 恒为 0% */
    function basePrice(track) {
        for (var i = 0; i < track.length; i++) {
            if (quote.isValidPrice(track[i])) return Number(track[i].price);
        }
        return null;
    }

    function cellHtml(label, value, base) {
        var pct = pctFrom(value, base);
        return '<div class="tl-cell">'
            + '<span class="tl-label">' + label + '</span>'
            + '<span class="tl-value ' + quote.trendClass(pct) + '">' + util.formatPercent(pct) + '</span>'
            + '</div>';
    }

    function timelineHtml(track) {
        var base = basePrice(track);
        var html = '';

        for (var i = track.length - 1; i >= 0; i--) {
            var record = track[i] || {};
            if (!quote.isValidPrice(record)) continue;

            var change = quote.dailyChange(record);
            var gain = pctFrom(record.price, base);
            var dayIndex = 'D' + i;

            html += '<div class="timeline-day' + (i === 0 ? ' day0' : '') + '">'
                + '<div class="tl-header">'
                + '<div class="tl-meta">'
                + '<span class="tl-date">' + util.escapeHTML(record.date || '日期待补充') + '</span>'
                + '<span class="tl-day-idx' + (i === 0 ? ' is-day0' : '') + '">' + dayIndex + '</span>'
                + '</div>'
                + '<div class="tl-price-group">'
                + '<span class="tl-metric">'
                + '<span class="tl-tag">累计</span>'
                + '<span class="tl-gain ' + quote.trendClass(gain) + '">' + util.formatPercent(gain) + '</span>'
                + '</span>'
                + '<span class="tl-metric">'
                + '<span class="tl-tag">当日</span>'
                + '<span class="tl-change ' + quote.trendClass(change) + '">' + util.formatPercent(change) + '</span>'
                + '</span>'
                + '</div>'
                + '</div>'
                + '<div class="tl-grid">'
                + cellHtml('开盘', record.open, base)
                + cellHtml('最高', record.high, base)
                + cellHtml('最低', record.low, base)
                + cellHtml('昨收', record.prevClose, base)
                + '</div>'
                + '</div>';
        }

        /* 统一套一层 .timeline：竖直轴线由这一层画，才能连续贯通，
           而不会因为每天一个 border-left 被 margin 切成一段一段。 */
        return html ? '<div class="timeline">' + html + '</div>' : '';
    }

    /** 把一只标的当前的数据铺进抽屉（同步前后各调一次） */
    function renderStock(stock) {
        var metrics = quote.returnsOf(stock);

        util.el('drawerName').textContent = stock.name || '未命名标的';
        util.el('drawerCode').textContent = stock.code || '--';

        util.el('statDays').textContent = metrics.validCount ? metrics.daysTracked : '—';

        var returnEl = util.el('statReturn');
        returnEl.textContent = util.formatPercent(metrics.cumulative);
        returnEl.className = 'stat-val ' + quote.trendClass(metrics.cumulative);

        if (metrics.validCount) {
            /* 最大回撤：以买入价为基准，取所有「最低价 / 收盘价」里最深的那个点。
               不给最高价收益 —— 那只在每日卡片里看才有意义，头部讲风控。 */
            var base = basePrice(metrics.track);
            var drawdown = null;
            metrics.validTrack.forEach(function (item) {
                [item.low, item.price].forEach(function (value) {
                    var pct = pctFrom(value, base);
                    if (pct !== null && (drawdown === null || pct < drawdown)) drawdown = pct;
                });
            });
            var drawdownEl = util.el('statHighLow');
            drawdownEl.textContent = util.formatPercent(drawdown);
            drawdownEl.className = 'stat-val stat-val--sm ' + quote.trendClass(drawdown);
        } else {
            var idleEl = util.el('statHighLow');
            idleEl.textContent = '等待行情';
            idleEl.className = 'stat-val stat-val--sm';
        }

        var content = util.el('timelineContent');
        if (!metrics.track.length) {
            var emptyText = stock.syncState === 'error'
                ? '行情暂未取到。可能是接口限流或网络异常，稍后重新打开会再次尝试。'
                : '正在同步行情…';
            content.innerHTML = '<div class="empty-state">' + emptyText + '</div>';
        } else {
            content.innerHTML = timelineHtml(metrics.track)
                || '<div class="empty-state">没有可展示的有效行情记录。</div>';
        }
    }

    function open(date, group, stockId) {
        var stock = store.findStock(date, group, stockId);
        if (!stock) { util.showToast('这条记录可能已被删除或更新'); return; }

        var token = ++openToken;

        renderStock(stock);
        util.el('timelineContent').scrollTop = 0;

        overlay.classList.add('active');
        drawer.classList.add('active');

        if (!BT.market || !stock.code || stock.code === '--') return;

        BT.market.ensureSeries(stock).then(function () {
            if (token !== openToken) return;
            renderStock(stock);
            if (BT.feed) BT.feed.updateRow(stock);
        }, function () {
            if (token !== openToken) return;
            renderStock(stock);
            if (BT.feed) BT.feed.updateRow(stock);
        });
    }

    function close() {
        openToken++;
        overlay.classList.remove('active');
        drawer.classList.remove('active');
    }

    function bindEvents() {
        if (bound) return;
        bound = true;

        overlay = util.el('drawerOverlay');
        drawer = util.el('detailDrawer');

        overlay.addEventListener('click', close);
        util.el('drawerClose').addEventListener('click', close);

        // 移动端：在抽屉头部向下拖动可关闭
        var startY = null;
        var header = drawer.querySelector('.drawer-header');
        header.addEventListener('touchstart', function (event) {
            startY = event.touches[0].clientY;
        }, { passive: true });
        header.addEventListener('touchmove', function (event) {
            if (startY === null) return;
            var dy = event.touches[0].clientY - startY;
            if (dy > 0) drawer.style.transform = 'translateY(' + dy + 'px)';
        }, { passive: true });
        header.addEventListener('touchend', function (event) {
            if (startY === null) return;
            var dy = event.changedTouches[0].clientY - startY;
            drawer.style.transform = '';
            if (dy > 90) close();
            startY = null;
        }, { passive: true });
    }

    BT.drawer = { open: open, close: close, bindEvents: bindEvents };
})(window.BT);
