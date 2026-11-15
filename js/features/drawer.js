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

    function formatValue(value) {
        return util.isNum(value) ? Number(value).toFixed(2) : '—';
    }

    function timelineHtml(track) {
        var html = '';

        for (var i = track.length - 1; i >= 0; i--) {
            var record = track[i] || {};
            if (!quote.isValidPrice(record)) continue;

            var change = quote.dailyChange(record);
            var trend = quote.trendClass(change);
            var dayIndex = i === 0 ? '推荐日(D0)' : '追踪(D' + i + ')';

            html += '<div class="timeline-day' + (i === 0 ? ' day0' : '') + '">'
                + '<div class="tl-header">'
                + '<div>'
                + '<span class="tl-date">' + util.escapeHTML(record.date || '日期待补充') + '</span>'
                + '<span class="tl-day-idx">' + dayIndex + '</span>'
                + '</div>'
                + '<div class="tl-price-group">'
                + '<div class="tl-price">' + Number(record.price).toFixed(2) + '</div>'
                + '<div class="tl-change ' + trend + '">' + util.formatPercent(change) + '</div>'
                + '</div>'
                + '</div>'
                + '<div class="tl-grid">'
                + '<div class="tl-cell"><span>今开</span><span>' + formatValue(record.open) + '</span></div>'
                + '<div class="tl-cell"><span>最高</span><span>' + formatValue(record.high) + '</span></div>'
                + '<div class="tl-cell"><span>最低</span><span>' + formatValue(record.low) + '</span></div>'
                + '<div class="tl-cell"><span>昨收</span><span>' + formatValue(record.prevClose) + '</span></div>'
                + '</div>'
                + '</div>';
        }

        return html;
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
            var prices = metrics.validTrack.map(function (item) { return Number(item.price); });
            util.el('statHighLow').textContent = Math.max.apply(null, prices).toFixed(2)
                + ' / ' + Math.min.apply(null, prices).toFixed(2);
        } else {
            util.el('statHighLow').textContent = '等待行情';
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
