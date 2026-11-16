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
    var openStockId = null;   // 当前抽屉展示的标的 id（编辑/删除据此定位）

    function currentRecord() {
        if (!openStockId) return null;
        return store.locateStock(openStockId);
    }

    /**
     * 相对基准价的收益率。
     * 详情页只谈百分比不谈价格：这条记录让用户赚了多少个点，才是要复盘的东西。
     */
    function pctFrom(value, base) {
        if (!util.isNum(value) || !base || !(base > 0)) return null;
        return (Number(value) / base - 1) * 100;
    }

    /**
     * 成本价：推荐日收盘 = 买入价。
     * 只给「累计收益」和「最大回撤」当分母 —— 这两个指标回答的是
     * 「从建仓到现在赚/亏了多少」，基准必须是建仓成本。
     */
    function basePrice(track) {
        for (var i = 0; i < track.length; i++) {
            if (quote.isValidPrice(track[i])) return Number(track[i].price);
        }
        return null;
    }

    /**
     * 日内基准：该交易日的前收盘价。
     * 开盘/最高/最低/收盘 只有相对「前收」才是行情软件的通行口径；
     * 拿成本价当分母，会把 11-13 这种「开 17.25、收 18.02、涨 5.01%」的阳线
     * 画成「开盘跌 4.27%、最高才涨 0.28%」，和同花顺 / 东财完全对不上。
     * 前收缺失时退回上一条有效记录的收盘价（序列首根没有前收，只能给 null）。
     */
    function prevCloseOf(record, fallback) {
        var prev = record && record.prevClose;
        if (util.isNum(prev) && Number(prev) > 0) return Number(prev);
        return util.isNum(fallback) && Number(fallback) > 0 ? Number(fallback) : null;
    }

    function cellHtml(label, value, base) {
        var pct = pctFrom(value, base);
        return '<div class="tl-cell">'
            + '<span class="tl-label">' + label + '</span>'
            + '<span class="tl-value ' + quote.trendClass(pct) + '">' + util.formatPercent(pct) + '</span>'
            + '</div>';
    }

    function timelineHtml(track) {
        var entry = basePrice(track);   // 成本价：累计收益的 100%
        var bases = [];                 // 每天自己的「前收」
        var prevPrice = null;

        for (var i = 0; i < track.length; i++) {
            var item = track[i] || {};
            if (!quote.isValidPrice(item)) { bases.push(null); continue; }
            bases.push(prevCloseOf(item, prevPrice));
            prevPrice = Number(item.price);
        }

        var html = '';

        for (var j = track.length - 1; j >= 0; j--) {
            var record = track[j] || {};
            if (!quote.isValidPrice(record)) continue;

            var gain = pctFrom(record.price, entry);
            var base = bases[j];
            var dayIndex = 'D' + j;

            html += '<div class="timeline-day' + (j === 0 ? ' day0' : '') + '">'
                + '<div class="tl-header">'
                + '<div class="tl-meta">'
                + '<span class="tl-date">' + util.escapeHTML(record.date || '日期待补充') + '</span>'
                + '<span class="tl-day-idx' + (j === 0 ? ' is-day0' : '') + '">' + dayIndex + '</span>'
                + '</div>'
                /* 只留「累计」：当天的涨跌幅在下方四格的「收盘」里已经有了，
                   重复一遍反而把 header 挤满。 */
                + '<div class="tl-price-group">'
                + '<span class="tl-metric">'
                + '<span class="tl-tag">累计</span>'
                + '<span class="tl-change ' + quote.trendClass(gain) + '">' + util.formatPercent(gain) + '</span>'
                + '</span>'
                + '</div>'
                + '</div>'
                /* 四格是「当天这根 K 线相对前收的位置」，与右上「当日」同口径。
                   最后一格给收盘价而不是昨收 —— 昨收是它的分母，写出来恒为 0.00%。 */
                + '<div class="tl-grid">'
                + cellHtml('开盘', record.open, base)
                + cellHtml('最高', record.high, base)
                + cellHtml('最低', record.low, base)
                + cellHtml('收盘', record.price, base)
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

        util.el('statDays').textContent = metrics.validCount ? metrics.daysTracked : util.NO_DATA;

        var returnEl = util.el('statReturn');
        returnEl.textContent = util.formatPercent(metrics.cumulative);
        returnEl.className = 'stat-val ' + quote.trendClass(metrics.cumulative);

        if (metrics.validCount) {
            /* 最大回撤：按「推荐日收盘买入」的持仓口径，取建仓之后所有
               「最低价 / 收盘价」里最深的那个点。
               推荐日当天的最低价发生在建仓之前（收盘才买），算进去会把
               「当天先跌 6% 再拉涨停」误报成持仓亏了 6% —— 所以从 D1 起算。
               全程没跌破成本时给 0.00%，不回填正数。 */
            var base = basePrice(metrics.track);
            var drawdown = null;

            for (var d = 1; d < metrics.track.length; d++) {
                var dayRecord = metrics.track[d];
                if (!quote.isValidPrice(dayRecord)) continue;
                [dayRecord.low, dayRecord.price].forEach(function (value) {
                    var pct = pctFrom(value, base);
                    if (pct !== null && (drawdown === null || pct < drawdown)) drawdown = pct;
                });
            }
            if (drawdown === null || drawdown > 0) drawdown = 0;

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
        openStockId = stock.id;

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
        openStockId = null;
        overlay.classList.remove('active');
        drawer.classList.remove('active');
    }

    /* ---------------- 编辑 ---------------- */
    /* 面板关闭有 320ms 收起动画，紧接着开下一个面板会打断动画造成闪动，
       所以统一等到动画结束（340ms）再开下一层。 */
    var NEXT_PANEL_DELAY = 340;

    function openEditor() {
        var found = currentRecord();
        if (!found) { util.showToast('这条记录可能已被删除'); return; }

        var stock = found.stock;

        // 另一组：优选组里显示「移动至落选组」，反之亦然
        var targetGroup = found.group === store.GROUPS[0] ? store.GROUPS[1] : store.GROUPS[0];

        BT.actionSheet.open({
            title: stock.name + ' · ' + (stock.code || '--'),
            options: [
                { value: 'date', label: '修改推荐日期' },
                { value: 'group', label: '移动至' + targetGroup },
                { value: 'delete', label: '删除这只标的' }
            ],
            onPick: function (value) {
                if (value === 'date') {
                    setTimeout(function () { editDate(stock); }, NEXT_PANEL_DELAY);
                } else if (value === 'group') {
                    setTimeout(function () { moveGroup(stock, targetGroup); }, NEXT_PANEL_DELAY);
                } else if (value === 'delete') {
                    setTimeout(function () { confirmDelete(stock); }, NEXT_PANEL_DELAY);
                }
            }
        });
    }

    /** 改组别：留在原日期，行情与收益全部沿用，只是换个分组归属 */
    function moveGroup(stock, targetGroup) {
        var result = store.moveStockToGroup(stock.id, targetGroup);
        if (!result) { util.showToast('「' + targetGroup + '」里已经有同一只标的了'); return; }
        if (!result.moved) { close(); return; }

        store.persist(false);
        close();
        if (BT.app) BT.app.render();
        util.showToast('已移至「' + targetGroup + '」');
    }

    /** 改 D0 日期：整条 track 作废重拉，D1 / D2 自然按新基准顺延 */
    function editDate(stock) {
        var today = util.todayISO();

        BT.dateWheel.open(stock.recDate || today, function (iso) {
            if (!iso || iso === stock.recDate) return;
            if (iso > today) { util.showToast('推荐日期不能晚于今天'); return; }

            var result = store.moveStockToDate(stock.id, iso);
            if (!result) { util.showToast('这个日期下已经有同一只标的了'); return; }
            if (!result.moved) return;

            store.persist(false);
            store.setSelectedDate(iso);
            close();
            if (BT.app) BT.app.render();

            util.showToast('推荐日已改为 ' + iso + '，正在重新计算');

            if (!BT.market) return;
            BT.market.ensureSeries(result.stock, { force: true }).then(function () {
                if (BT.feed) BT.feed.updateRow(result.stock);
                if (BT.app) BT.app.updateBackToLatest();
            }, function () {
                if (BT.feed) BT.feed.updateRow(result.stock);
                util.showToast('行情暂时取不到，稍后重新打开详情会自动重试');
            });
        }, { anchor: null });
    }

    function confirmDelete(stock) {
        BT.actionSheet.open({
            title: '删除「' + stock.name + '」后无法恢复',
            tone: 'danger',
            options: [{ value: 'delete', label: '确认删除' }],
            onPick: function () {
                var removed = store.removeStock(stock.id);
                if (!removed) { util.showToast('删除失败，记录可能已不存在'); return; }

                store.persist(false);
                close();
                if (BT.app) BT.app.render();
                util.showToast('已删除「' + stock.name + '」');
            }
        });
    }

    function bindEvents() {
        if (bound) return;
        bound = true;

        overlay = util.el('drawerOverlay');
        drawer = util.el('detailDrawer');

        overlay.addEventListener('click', close);
        util.el('drawerEdit').addEventListener('click', openEditor);

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
