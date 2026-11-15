/* ============================================================
   app.js — 编排层：串起数据、视图与交互
   启动顺序：store.init() → 绑定事件 → 首屏 render()
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var store = BT.store;

    var SCROLL_HINT = 600;   // 滚动超过这个距离就出现「回到最新」

    function scroller() { return util.el('appContent'); }

    /* ---------------- 工具栏 ---------------- */
    function updateToolbar() {
        var tab = store.state.tab;

        document.querySelectorAll('.tab-btn').forEach(function (btn) {
            var on = btn.dataset.tab === tab;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });

        var pill = util.el('datePill');
        var isBatch = tab === 'batch';
        pill.hidden = !isBatch;
        if (isBatch) util.el('datePillText').textContent = store.state.selectedDate || '选择日期';
    }

    /* ---------------- 回到最新 ---------------- */
    function updateBackToLatest() {
        var btn = util.el('backToLatest');
        var box = scroller();
        if (!btn || !box) return;

        var isOldDate = store.state.dates.length > 0 && store.state.selectedDate !== store.state.dates[0];
        var scrolled = box.scrollTop > SCROLL_HINT;
        btn.classList.toggle('visible', store.state.tab === 'batch' && (isOldDate || scrolled));
    }

    function goToLatest() {
        if (!store.state.dates.length) { util.showToast('暂无历史记录'); return; }
        store.setSelectedDate(store.state.dates[0]);
        store.setTab('batch');
        render({ scrollActive: true });
    }

    /* ---------------- 主渲染 ---------------- */
    function render(options) {
        options = options || {};

        BT.sidebar.render({ scrollActive: !!options.scrollActive });
        updateToolbar();

        if (store.state.tab === 'dashboard') {
            BT.feed.teardown();
            BT.dashboard.render();
        } else {
            BT.feed.resetTo(store.state.selectedDate);
        }

        updateBackToLatest();
        if (!options.keepScroll) scroller().scrollTop = 0;
    }

    /* ---------------- 事件绑定（只在启动时执行一次） ---------------- */
    function bindGlobalEvents() {
        document.querySelector('.tab-group').addEventListener('click', function (event) {
            var btn = event.target.closest('.tab-btn');
            if (!btn || store.state.tab === btn.dataset.tab) return;
            store.setTab(btn.dataset.tab);
            render();
        });

        util.el('datePill').addEventListener('click', BT.calendar.open);
        util.el('backToLatest').addEventListener('click', goToLatest);
        scroller().addEventListener('scroll', updateBackToLatest, { passive: true });

        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            // 浮层按层级从高到低关闭：动作面板 → 滚轮 → 日历 → 抽屉 → 录入
            if (BT.actionSheet.isOpen()) { BT.actionSheet.close(); return; }
            if (BT.dateWheel.isOpen()) { BT.dateWheel.close(); return; }
            BT.calendar.close();
            BT.drawer.close();
            BT.addStock.close();
        });

        // 断点切换时补建/重建侧边栏
        var lastDesktop = window.matchMedia('(min-width: 768px)').matches;
        window.addEventListener('resize', function () {
            var nowDesktop = window.matchMedia('(min-width: 768px)').matches;
            if (nowDesktop === lastDesktop) return;
            lastDesktop = nowDesktop;
            if (nowDesktop) BT.sidebar.render();
        }, { passive: true });
    }

    /* ---------------- 启动 ---------------- */
    function start() {
        BT.calendar.bindEvents();
        BT.drawer.bindEvents();
        BT.addStock.bindEvents();
        BT.sidebar.bindEvents();
        BT.feed.bindEvents();
        bindGlobalEvents();

        store.init().then(function () {
            render();

            if (store.state.legacyCleared) {
                util.showToast('旧版演示数据已清除，现在只显示真实行情');
            }
        }).catch(function (error) {
            console.error('[BackTrack] 初始化失败', error);
            util.showToast('数据加载失败，请刷新页面重试');
        });
    }

    BT.app = {
        render: render,
        goToLatest: goToLatest,
        updateBackToLatest: updateBackToLatest
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})(window.BT);
