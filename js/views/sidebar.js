/* ============================================================
   views/sidebar.js — 桌面端日期树
   ------------------------------------------------------------
   针对旧版「点了以后会乱」的问题，这里做了三件事：
     1. 展开状态存内存（openYears / openMonths），重建不丢失
     2. 点日期只切换 active 高亮，不重建整棵树 → 不闪、不折叠
     3. 选中项自动滚动到侧边栏可视区中间
   另外日期加了星期，避免一串「1 日 2 日 3 日」分不清。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var store = BT.store;

    var openYears = {};
    var openMonths = {};
    var builtSignature = '';
    var bound = false;

    var navEl = null;

    function isDesktop() {
        return window.matchMedia('(min-width: 768px)').matches;
    }

    /* ---------------- 数据分组 ---------------- */
    function groupDates() {
        var years = [];
        var yearIndex = {};

        store.state.dates.forEach(function (date) {
            var year = date.slice(0, 4);
            var month = date.slice(0, 7);

            if (!yearIndex[year]) {
                yearIndex[year] = { year: year, count: 0, months: [], monthIndex: {} };
                years.push(yearIndex[year]);
            }
            var y = yearIndex[year];
            y.count++;

            if (!y.monthIndex[month]) {
                y.monthIndex[month] = { key: month, label: Number(month.slice(5, 7)) + ' 月', dates: [] };
                y.months.push(y.monthIndex[month]);
            }
            y.monthIndex[month].dates.push(date);
        });

        return years;
    }

    /* ---------------- 构建 HTML ---------------- */
    function buildHtml() {
        var years = groupDates();
        var selected = store.state.selectedDate;
        var activeYear = selected ? selected.slice(0, 4) : '';
        var activeMonth = selected ? selected.slice(0, 7) : '';

        return years.map(function (year) {
            // 首次构建时，把选中日期所在的年/月默认展开
            if (!(year.year in openYears)) openYears[year.year] = year.year === activeYear;

            var monthHtml = year.months.map(function (month) {
                if (!(month.key in openMonths)) openMonths[month.key] = month.key === activeMonth;

                var dateHtml = month.dates.map(function (date) {
                    return '<button class="nav-date' + (date === selected ? ' active' : '') + '"'
                        + ' type="button" data-date="' + util.escapeHTML(date) + '">'
                        + '<span>' + util.escapeHTML(date.slice(8)) + ' 日</span>'
                        + '<span class="nav-date-week">周' + util.weekdayLabel(date) + '</span>'
                        + '</button>';
                }).join('');

                var monthOpen = openMonths[month.key] ? ' open' : '';
                return '<div class="nav-month" data-month="' + month.key + '">'
                    + '<button class="nav-toggle nav-toggle--month" type="button"'
                    + ' data-toggle-month="' + month.key + '"'
                    + ' aria-expanded="' + (openMonths[month.key] ? 'true' : 'false') + '">'
                    + '<svg class="icon nav-caret" aria-hidden="true"><use href="#i-chevron-right"></use></svg>'
                    + '<span class="nav-toggle-label">' + month.label + '</span>'
                    + '<span class="nav-toggle-meta">' + month.dates.length + '</span>'
                    + '</button>'
                    + '<div class="nav-children' + monthOpen + '">' + dateHtml + '</div>'
                    + '</div>';
            }).join('');

            var yearOpen = openYears[year.year] ? ' open' : '';
            return '<div class="nav-year" data-year="' + year.year + '">'
                + '<button class="nav-toggle nav-toggle--year" type="button"'
                + ' data-toggle-year="' + year.year + '"'
                + ' aria-expanded="' + (openYears[year.year] ? 'true' : 'false') + '">'
                + '<svg class="icon nav-caret" aria-hidden="true"><use href="#i-chevron-right"></use></svg>'
                + '<span class="nav-toggle-label">' + year.year + ' 年</span>'
                + '<span class="nav-toggle-meta">' + year.count + '</span>'
                + '</button>'
                + '<div class="nav-children' + yearOpen + '">' + monthHtml + '</div>'
                + '</div>';
        }).join('');
    }

    /* ---------------- 展开/收起 ---------------- */
    function applyOpenState() {
        if (!navEl) return;
        navEl.querySelectorAll('[data-toggle-year]').forEach(function (btn) {
            var open = !!openYears[btn.dataset.toggleYear];
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            var children = btn.nextElementSibling;
            if (children) children.classList.toggle('open', open);
        });
        navEl.querySelectorAll('[data-toggle-month]').forEach(function (btn) {
            var open = !!openMonths[btn.dataset.toggleMonth];
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            var children = btn.nextElementSibling;
            if (children) children.classList.toggle('open', open);
        });
    }

    /** 展开选中日期所在年、月（例如从日历选了一个折叠月份里的日期） */
    function ensureAncestorsOpen() {
        var selected = store.state.selectedDate;
        if (!selected) return;
        openYears[selected.slice(0, 4)] = true;
        openMonths[selected.slice(0, 7)] = true;
        applyOpenState();
    }

    /* ---------------- 高亮同步 ---------------- */
    function syncActive(shouldScroll) {
        if (!navEl) return;

        var before = navEl.querySelector('.nav-date.active');
        var target = navEl.querySelector('.nav-date[data-date="' + store.state.selectedDate + '"]');

        if (before && before !== target) before.classList.remove('active');
        if (!target) return;

        target.classList.add('active');

        if (shouldScroll) {
            // 用 sidebar-nav 自己的 scrollTop 计算，避免带动整个页面
            var container = navEl;
            var top = target.offsetTop - container.clientHeight / 2 + target.offsetHeight / 2;
            container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        }
    }

    /* ---------------- 渲染 ---------------- */
    function render(options) {
        if (!isDesktop()) return;

        navEl = util.el('pcTreeNav');
        if (!navEl) return;

        var dates = store.state.dates;
        var signature = dates.length + '|' + (dates[0] || '') + '|' + (dates[dates.length - 1] || '');

        // 只有数据集变化才重建树，否则只更新高亮
        if (signature !== builtSignature) {
            navEl.innerHTML = buildHtml();
            builtSignature = signature;
        }

        var count = util.el('sidebarCount');
        if (count) count.textContent = dates.length + ' 个批次';

        var overview = util.el('sidebarOverview');
        if (overview) overview.classList.toggle('active', store.state.tab === 'dashboard');

        // 无论从哪条路径改的日期，都保证它在树里是展开可见的
        ensureAncestorsOpen();

        syncActive(!!(options && options.scrollActive));
    }

    /* ---------------- 交互 ---------------- */
    function bindEvents() {
        if (bound) return;
        bound = true;

        navEl = util.el('pcTreeNav');

        navEl.addEventListener('click', function (event) {
            var dateBtn = event.target.closest('.nav-date');
            if (dateBtn) {
                event.preventDefault();
                if (dateBtn.dataset.date === store.state.selectedDate && store.state.tab === 'batch') return;
                store.setSelectedDate(dateBtn.dataset.date);
                store.setTab('batch');
                BT.app.render();
                return;
            }

            var monthBtn = event.target.closest('[data-toggle-month]');
            if (monthBtn) {
                var monthKey = monthBtn.dataset.toggleMonth;
                openMonths[monthKey] = !openMonths[monthKey];
                applyOpenState();
                return;
            }

            var yearBtn = event.target.closest('[data-toggle-year]');
            if (yearBtn) {
                var yearKey = yearBtn.dataset.toggleYear;
                openYears[yearKey] = !openYears[yearKey];
                applyOpenState();
            }
        });

        var overviewBtn = util.el('sidebarOverview');
        if (overviewBtn) {
            overviewBtn.addEventListener('click', function () {
                store.setTab('dashboard');
                BT.app.render();
            });
        }
    }

    BT.sidebar = {
        render: render,
        bindEvents: bindEvents,
        ensureAncestorsOpen: ensureAncestorsOpen
    };
})(window.BT);
