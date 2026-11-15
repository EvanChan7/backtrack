/* ============================================================
   features/add-stock.js — 录入推荐
   ------------------------------------------------------------
   流程：输入代码/名称 → 用行情检索接口校验（拿到真实名称与 secid）
        → 保存 → 立刻同步前复权日线 → 列表逐行回填。
   校验失败会直接拦下：宁可不保存，也不写入一个查不到的「标的」。
   ============================================================ */
(function (BT) {
    'use strict';

    var util = BT.util;
    var store = BT.store;

    var modal = null;
    var bound = false;
    var submitting = false;
    var identifyToken = 0;

    /** 把 ISO 日期同时写进隐藏域和可见文案（提交逻辑仍只读 #inputDate.value） */
    function setDate(iso) {
        util.el('inputDate').value = iso;
        util.el('inputDateText').textContent = iso;
    }

    /** 组别：隐藏域供提交读取，可见按钮只负责展示 */
    function setGroup(group) {
        util.el('selectGroup').value = group;
        util.el('groupText').textContent = group;
    }

    function open() {
        setDate(store.state.selectedDate || util.todayISO());
        setGroup(util.el('selectGroup').value || store.GROUPS[0]);
        showHint('');

        modal.classList.add('active');

        // 桌面端直接聚焦输入框；移动端不自动拉起键盘，
        // 否则键盘会和面板进场动画抢位置，观感很毛躁。
        if (!window.matchMedia('(max-width: 767px)').matches) {
            util.el('inputStock').focus();
        }
    }

    function close() {
        BT.actionSheet.close();
        modal.classList.remove('active');
        util.el('inputStock').value = '';
        showHint('');
    }

    /** 打开三列滚轮选择日期 */
    function openPicker() {
        BT.dateWheel.open(util.el('inputDate').value || util.todayISO(), setDate);
    }

    /** 底部选项面板（替代原生 select） */
    function openGroupSheet() {
        BT.actionSheet.open({
            title: '归入组别',
            value: util.el('selectGroup').value,
            options: store.GROUPS.map(function (group) {
                return { value: group, label: group };
            }),
            onPick: setGroup
        });
    }

    function showHint(text, tone) {
        var hint = util.el('stockHint');
        hint.textContent = text || '';
        hint.hidden = !text;
        hint.className = 'form-hint form-hint--inline' + (tone ? ' is-' + tone : '');
    }

    /** 识别用户输入，返回 { code, name, secid, verified } */
    function identify(raw) {
        var token = ++identifyToken;
        showHint('正在识别…');

        return BT.market.resolve(raw).then(function (info) {
            if (token === identifyToken) {
                showHint(info.name + ' · ' + info.code + (info.verified ? '' : '（接口未校验）'));
            }
            return info;
        }, function (error) {
            if (token === identifyToken) {
                showHint(error && error.message ? error.message : '未能识别该标的', 'error');
            }
            throw error;
        });
    }

    function submit(button) {
        if (submitting) return;

        var date = util.el('inputDate').value;
        var query = util.el('inputStock').value.trim();
        var group = util.el('selectGroup').value;

        if (!date || !query) { util.showToast('请填写推荐日期和股票代码/名称'); return; }
        if (!util.isValidISODate(date)) { util.showToast('日期无效，请重新选择'); return; }
        if (date > util.todayISO()) { util.showToast('推荐日期不能晚于今天'); return; }
        if (query.length > 40) { util.showToast('股票名称或代码最多输入 40 个字符'); return; }

        var originalText = button.textContent;
        submitting = true;
        button.disabled = true;
        button.textContent = '正在校验…';

        identify(query).then(function (info) {
            if (store.hasDuplicate(date, group, info.code, info.name)) {
                throw { userMessage: '该标的已在此日期、此分组中' };
            }

            var stock = {
                id: util.makeId(),
                name: info.name,
                code: info.code,
                secid: info.secid,
                recDate: date,
                track: [],
                syncState: 'loading',
                pendingMarketData: true
            };

            store.addStock(date, group, stock);
            store.setSelectedDate(date);
            store.setTab('batch');

            button.textContent = '正在保存…';

            return store.persist(false).then(function (ok) {
                close();
                BT.app.render({ scrollActive: true });
                util.showToast(ok ? '已保存，正在同步行情…' : '记录仅保留在当前页面，请立即导出备份');

                // 保存后立刻补一次行情，列表只替换这一行，不重排整页
                BT.market.ensureSeries(stock).then(function () {
                    BT.feed.updateRow(stock);
                }, function () {
                    BT.feed.updateRow(stock);
                    util.showToast('行情暂未取到，稍后会自动重试');
                });
            });
        }).catch(function (error) {
            var message = (error && (error.userMessage || error.message)) || '保存失败，请重试';
            util.showToast(message);
        }).then(function () {
            submitting = false;
            button.disabled = false;
            button.textContent = originalText;
        });
    }

    function bindEvents() {
        if (bound) return;
        bound = true;

        modal = util.el('addModal');

        // 点击遮罩关闭
        modal.addEventListener('click', function (event) {
            if (event.target === modal) close();
        });

        util.el('fabAdd').addEventListener('click', open);
        util.el('inputDateBtn').addEventListener('click', openPicker);
        util.el('groupBtn').addEventListener('click', openGroupSheet);
        util.el('btnConfirmAdd').addEventListener('click', function () { submit(this); });
        util.el('btnCancelAdd').addEventListener('click', close);

        // 离开输入框时做一次识别，用户能立刻确认「查到的是不是这只票」
        util.el('inputStock').addEventListener('blur', function () {
            var raw = this.value.trim();
            if (!raw || submitting) return;
            identify(raw).catch(function () { /* 提示已在 showHint 中给出 */ });
        });
        util.el('inputStock').addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { event.preventDefault(); submit(util.el('btnConfirmAdd')); }
        });

        util.el('backupFileInput').addEventListener('change', function (event) {
            var file = event.target.files && event.target.files[0];
            if (file) {
                store.importBackup(file).then(function (ok) {
                    if (ok) BT.app.render();
                });
            }
            event.target.value = '';
        });
    }

    BT.addStock = { open: open, close: close, bindEvents: bindEvents };
})(window.BT);
