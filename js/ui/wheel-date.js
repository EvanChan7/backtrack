/* ============================================================
   ui/wheel-date.js — 年 / 月 / 日 三列滚轮日期选择器
   ------------------------------------------------------------
   设计要点：
     · 用原生滚动 + scroll-snap 驱动，触屏惯性、鼠标滚轮、触控板都直接可用，
       不自己实现惯行动画，避免移动端手感发飘；
     · 只在滚动停止（90ms 无事件）后落定取值，滚动过程中只切换高亮样式；
     · 年 / 月变化后重建「日」列，自动处理大小月与闰年；
     · 面板不透明背景：滚轮必须与背后内容隔开，否则数字会糊在一起。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;

    var ITEM_H = 40;         // 必须与 css 中 --wheel-item-h 一致
    var YEARS_BACK = 15;     // 可选年份范围：今年+1 ~ 今年-15
    var SETTLE_MS = 90;
    var UNITS = { year: '年', month: '月', day: '日' };

    var root = null;
    var titleEl = null;
    var wheels = {};         // kind -> { el, items, values, index }
    var value = { y: 0, m: 1, d: 1 };
    var callback = null;
    var opened = false;
    var built = false;
    var hideTimer = null;
    var settleTimers = {};
    var rafPending = {};

    /* ---------------- 基础计算 ---------------- */
    function daysIn(y, m) { return new Date(y, m, 0).getDate(); }

    function yearList() {
        var now = new Date().getFullYear();
        var list = [];
        for (var y = now + 1; y >= now - YEARS_BACK; y--) list.push(y);
        return list;
    }

    function valuesOf(kind) {
        var list = [];
        var i;
        if (kind === 'year') return yearList();
        if (kind === 'month') {
            for (i = 1; i <= 12; i++) list.push(i);
            return list;
        }
        var total = daysIn(value.y, value.m);
        for (i = 1; i <= total; i++) list.push(i);
        return list;
    }

    /* ---------------- 构建 ---------------- */
    function build(kind, values) {
        var w = wheels[kind];
        var html = '<div class="wheel-track" role="presentation">';
        for (var i = 0; i < values.length; i++) {
            var text = kind === 'year' ? String(values[i]) : util.pad2(values[i]);
            html += '<div class="wheel-item" data-i="' + i + '" role="option" aria-selected="false">'
                + '<span class="wheel-num">' + text + '</span>'
                + '<span class="wheel-unit">' + UNITS[kind] + '</span>'
                + '</div>';
        }
        html += '</div>';

        w.el.innerHTML = html;
        w.values = values;
        w.index = -1;
        w.items = Array.prototype.slice.call(w.el.querySelectorAll('.wheel-item'));
    }

    function paint(kind, index) {
        var w = wheels[kind];
        if (!w.items.length || w.index === index) return;
        w.index = index;

        for (var i = 0; i < w.items.length; i++) {
            var dist = Math.abs(i - index);
            var item = w.items[i];
            item.classList.toggle('active', dist === 0);
            item.classList.toggle('near', dist === 1);
            item.setAttribute('aria-selected', dist === 0 ? 'true' : 'false');
        }
    }

    function indexFromScroll(kind) {
        var w = wheels[kind];
        var idx = Math.round(w.el.scrollTop / ITEM_H);
        return Math.max(0, Math.min(w.values.length - 1, idx));
    }

    function scrollToValue(kind, v, smooth) {
        var w = wheels[kind];
        var idx = w.values.indexOf(v);
        if (idx < 0) idx = 0;
        var top = idx * ITEM_H;

        if (smooth && w.el.scrollTo) w.el.scrollTo({ top: top, behavior: 'smooth' });
        else w.el.scrollTop = top;

        paint(kind, idx);
    }

    /* ---------------- 取值落定 ---------------- */
    function updateTitle() {
        if (titleEl) titleEl.textContent = util.toISO(new Date(value.y, value.m - 1, value.d));
    }

    function rebuildDay() {
        var total = daysIn(value.y, value.m);
        if (value.d > total) value.d = total;
        build('day', valuesOf('day'));
        scrollToValue('day', value.d, false);
    }

    function commit(kind) {
        var w = wheels[kind];
        if (!w || !w.values.length) return;

        var v = w.values[indexFromScroll(kind)];
        if (kind === 'year') {
            if (value.y === v) return;
            value.y = v;
            rebuildDay();
        } else if (kind === 'month') {
            if (value.m === v) return;
            value.m = v;
            rebuildDay();
        } else {
            if (value.d === v) return;
            value.d = v;
        }
        updateTitle();
    }

    function scheduleCommit(kind) {
        clearTimeout(settleTimers[kind]);
        settleTimers[kind] = setTimeout(function () { commit(kind); }, SETTLE_MS);
    }

    function onScroll(kind) {
        if (rafPending[kind]) return;
        rafPending[kind] = true;

        requestAnimationFrame(function () {
            rafPending[kind] = false;
            paint(kind, indexFromScroll(kind));
            scheduleCommit(kind);
        });
    }

    /* ---------------- 事件绑定（只绑一次） ---------------- */
    function bindWheel(kind) {
        var w = wheels[kind];
        var el = w.el;

        el.addEventListener('scroll', function () { onScroll(kind); }, { passive: true });

        // 点某一项 → 平滑滚到它（滚动结束后由 settle 落定，不直接改值）
        el.addEventListener('click', function (event) {
            var item = event.target.closest('.wheel-item');
            if (!item) return;
            var top = Number(item.dataset.i) * ITEM_H;
            if (el.scrollTo) el.scrollTo({ top: top, behavior: 'smooth' });
            else el.scrollTop = top;
        });

        // 键盘：上下键换一项
        el.addEventListener('keydown', function (event) {
            var step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            var idx = Math.max(0, Math.min(w.values.length - 1, indexFromScroll(kind) + step));
            if (el.scrollTo) el.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' });
            else el.scrollTop = idx * ITEM_H;
        });
    }

    function ensureBuilt() {
        if (built) return;
        built = true;

        root = util.el('datePicker');
        titleEl = util.el('pickerTitle');

        ['year', 'month', 'day'].forEach(function (kind) {
            var el = util.el('wheel' + kind.charAt(0).toUpperCase() + kind.slice(1));
            wheels[kind] = { el: el, items: [], values: [], index: -1 };
            bindWheel(kind);
        });

        build('year', valuesOf('year'));
        build('month', valuesOf('month'));
        build('day', valuesOf('day'));

        util.el('pickerMask').addEventListener('click', close);
        util.el('pickerCancel').addEventListener('click', close);
        util.el('pickerConfirm').addEventListener('click', confirm);

        // 打开状态下窗口尺寸变化（比如旋转屏幕 / 拉伸浏览器）重新定位
        window.addEventListener('resize', function () {
            if (opened) layout();
        }, { passive: true });
    }

    /* ---------------- 定位 ----------------
       手机：底部面板（CSS 负责），这里只清掉内联定位；
       桌面：贴着「日期字段」弹出气泡，自己算一次坐标并夹在视口内。 */
    function isDesktop() {
        return !!(window.matchMedia && window.matchMedia('(min-width: 768px)').matches);
    }

    function layout() {
        var sheet = root.querySelector('.picker-sheet');
        if (!sheet) return;

        var desktop = isDesktop();
        root.classList.toggle('picker--anchored', desktop);

        if (!desktop) {
            sheet.style.left = sheet.style.top = sheet.style.width = '';
            return;
        }

        var anchor = util.el('inputDateBtn');
        var width = Math.min(360, Math.max(300, (anchor ? anchor.offsetWidth : 320)));
        var height = sheet.offsetHeight || 332;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var rect = anchor ? anchor.getBoundingClientRect() : { left: 24, top: 80, bottom: 126 };

        var left = Math.min(Math.max(12, rect.left), vw - width - 12);
        var top = rect.bottom + 8;
        if (top + height > vh - 12) top = Math.max(12, rect.top - height - 8);

        sheet.style.left = left + 'px';
        sheet.style.top = top + 'px';
        sheet.style.width = width + 'px';
    }

    /* ---------------- 开关 ---------------- */
    function open(iso, onConfirm) {
        ensureBuilt();
        callback = onConfirm || null;

        var date = util.isValidISODate(iso) ? util.parseISO(iso) : new Date();
        var years = wheels.year.values;
        var minYear = years[years.length - 1];
        var maxYear = years[0];

        value = {
            y: Math.min(maxYear, Math.max(minYear, date.getFullYear())),
            m: date.getMonth() + 1,
            d: date.getDate()
        };
        // 兜底：年份被夹到范围内后，日可能超出该月天数（例如 2 月 30 日）
        value.d = Math.min(value.d, daysIn(value.y, value.m));

        clearTimeout(hideTimer);
        root.hidden = false;
        opened = true;

        // 等一帧让面板拿到布局尺寸，再定位并把三列滚到当前值
        requestAnimationFrame(function () {
            if (!opened) return;
            layout();
            root.classList.add('active');

            scrollToValue('year', value.y, false);
            scrollToValue('month', value.m, false);
            build('day', valuesOf('day'));
            scrollToValue('day', value.d, false);
            updateTitle();
        });
    }

    function close() {
        if (!root || !opened) return;
        opened = false;
        callback = null;
        root.classList.remove('active');

        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            if (!opened) root.hidden = true;
        }, 320);
    }

    function confirm() {
        var iso = util.toISO(new Date(value.y, value.m - 1, value.d));
        var done = callback;
        opened = false;
        callback = null;
        root.classList.remove('active');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            if (!opened) root.hidden = true;
        }, 320);

        if (done) done(iso);
    }

    BT.dateWheel = {
        open: open,
        close: close,
        isOpen: function () { return !!opened; }
    };
})(window.BT);
