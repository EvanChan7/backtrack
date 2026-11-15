/* ============================================================
   features/calendar.js — 日期选择器
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var store = BT.store;

    var overlay = null;
    var panel = null;
    var grid = null;
    var titleEl = null;

    var viewYear = new Date().getFullYear();
    var viewMonth = new Date().getMonth();
    var bound = false;

    function open() {
        var parts = String(store.state.selectedDate || util.todayISO()).split('-').map(Number);
        viewYear = parts[0];
        viewMonth = parts[1] - 1;
        render();
        overlay.classList.add('active');
        panel.classList.add('active');
    }

    function close() {
        overlay.classList.remove('active');
        panel.classList.remove('active');
    }

    function shiftMonth(delta) {
        var d = new Date(viewYear, viewMonth + delta, 1);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
        render();
    }

    function shiftYear(delta) {
        viewYear += delta;
        render();
    }

    function render() {
        titleEl.textContent = viewYear + ' - ' + util.pad2(viewMonth + 1);

        var firstDay = new Date(viewYear, viewMonth, 1);
        var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        var startWeekday = firstDay.getDay();
        var selected = store.state.selectedDate;

        var html = '';
        for (var i = 0; i < startWeekday; i++) html += '<div class="cal-day empty"></div>';

        for (var day = 1; day <= daysInMonth; day++) {
            var dateStr = viewYear + '-' + util.pad2(viewMonth + 1) + '-' + util.pad2(day);
            var hasData = store.state.db[dateStr] !== undefined;
            var classes = 'cal-day' + (hasData ? ' has-data' : '') + (dateStr === selected ? ' active' : '');
            html += '<div class="' + classes + '" data-date="' + dateStr + '" data-has-data="' + (hasData ? '1' : '0') + '">' + day + '</div>';
        }

        grid.innerHTML = html;
    }

    function selectDate(dateStr, hasData) {
        if (!hasData) { util.showToast('这一天没有推荐批次'); return; }
        store.setSelectedDate(dateStr);
        store.setTab('batch');
        close();
        BT.app.render({ scrollActive: true });
    }

    function bindEvents() {
        if (bound) return;
        bound = true;

        overlay = util.el('calendarOverlay');
        panel = util.el('calendarPanel');
        grid = util.el('calGrid');
        titleEl = util.el('calTitle');

        overlay.addEventListener('click', close);
        util.el('calPrevYear').addEventListener('click', function () { shiftYear(-1); });
        util.el('calNextYear').addEventListener('click', function () { shiftYear(1); });
        util.el('calPrevMonth').addEventListener('click', function () { shiftMonth(-1); });
        util.el('calNextMonth').addEventListener('click', function () { shiftMonth(1); });

        grid.addEventListener('click', function (event) {
            var cell = event.target.closest('.cal-day');
            if (!cell || !cell.dataset.date) return;
            selectDate(cell.dataset.date, cell.dataset.hasData === '1');
        });

        // 左右滑动切月（移动端）
        var startX = 0;
        var startY = 0;
        grid.addEventListener('touchstart', function (event) {
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, { passive: true });
        grid.addEventListener('touchend', function (event) {
            var dx = event.changedTouches[0].clientX - startX;
            var dy = event.changedTouches[0].clientY - startY;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) shiftMonth(dx > 0 ? -1 : 1);
        }, { passive: true });
    }

    BT.calendar = {
        open: open,
        close: close,
        bindEvents: bindEvents
    };
})(window.BT);
