/* ============================================================
   ui/action-sheet.js — 底部动作面板（单选）
   ------------------------------------------------------------
   用来替代原生 <select>：原生下拉在移动端是「系统弹窗」，样式不可控、
   和 app 的底部面板完全是两套交互。这里按移动端规范实现：
     · 底部升起的面板 + 遮罩淡入（与日期面板共用同一套动效令牌）
     · 标题在上、选项等宽排列、当前项打勾
     · 取消单独成块，和选项之间留一条间隙
   DOM 只创建一次，之后复用；不打开时不占位。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;

    var root = null;
    var titleEl = null;
    var listEl = null;
    var hideTimer = null;
    var opened = false;
    var current = { options: [], value: '', onPick: null };

    function ensureBuilt() {
        if (root) return;

        root = document.createElement('div');
        root.className = 'sheet';
        root.id = 'actionSheet';
        root.hidden = true;
        root.innerHTML =
            '<div class="sheet-mask"></div>'
            + '<div class="sheet-panel" role="dialog" aria-modal="true">'
            + '<div class="sheet-options">'
            + '<div class="sheet-title" hidden></div>'
            + '<div class="sheet-list" role="listbox"></div>'
            + '</div>'
            + '<button class="sheet-cancel" type="button">取消</button>'
            + '</div>';
        document.body.appendChild(root);

        titleEl = root.querySelector('.sheet-title');
        listEl = root.querySelector('.sheet-list');

        root.querySelector('.sheet-mask').addEventListener('click', close);
        root.querySelector('.sheet-cancel').addEventListener('click', close);

        listEl.addEventListener('click', function (event) {
            var btn = event.target.closest('.sheet-option');
            if (!btn) return;
            var value = btn.dataset.value;
            var handler = current.onPick;
            paint(value);
            close();
            if (handler) handler(value);
        });
    }

    /** 只切换高亮，不重建 DOM */
    function paint(value) {
        var nodes = listEl.querySelectorAll('.sheet-option');
        for (var i = 0; i < nodes.length; i++) {
            var on = nodes[i].dataset.value === value;
            nodes[i].classList.toggle('is-active', on);
            nodes[i].setAttribute('aria-selected', on ? 'true' : 'false');
        }
    }

    /**
     * @param {Object} config
     * @param {String} [config.title]   面板标题（如「归入组别」）
     * @param {Array}  config.options   [{ value, label }]
     * @param {String} [config.value]   当前选中值
     * @param {String} [config.tone]    'danger' 时选项转为危险色（用于二次确认删除）
     * @param {Function} [config.onPick] 选中回调，参数为新值
     */
    function open(config) {
        ensureBuilt();
        config = config || {};

        current = {
            options: config.options || [],
            value: config.value || '',
            onPick: config.onPick || null
        };

        root.classList.toggle('sheet--danger', config.tone === 'danger');

        titleEl.textContent = config.title || '';
        titleEl.hidden = !config.title;

        listEl.innerHTML = current.options.map(function (item) {
            var on = item.value === current.value;
            return '<button class="sheet-option' + (on ? ' is-active' : '') + '" type="button"'
                + ' role="option" aria-selected="' + (on ? 'true' : 'false') + '"'
                + ' data-value="' + util.escapeHTML(item.value) + '">'
                + '<span>' + util.escapeHTML(item.label || item.value) + '</span>'
                + '<svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg>'
                + '</button>';
        }).join('');

        clearTimeout(hideTimer);
        root.hidden = false;
        opened = true;
        document.body.classList.add('sheet-open');
        if (util.repositionToast) util.repositionToast();

        // 先让面板以 translateY(100%) 完成一次布局，再加 active 才有过渡起点
        requestAnimationFrame(function () {
            if (opened) root.classList.add('active');
        });
    }

    function close() {
        if (!root || !opened) return;
        opened = false;
        document.body.classList.remove('sheet-open');
        root.classList.remove('active');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            if (!opened) root.hidden = true;
        }, 320);
    }

    BT.actionSheet = {
        open: open,
        close: close,
        isOpen: function () { return !!opened; }
    };
})(window.BT);
