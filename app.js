'use strict';

const APP_VERSION = '1.4.8';
const ROWS = 5;
const COLS = 6;
const KEYS = {
    students: 'maseok_2_2_students_v2',
    avoid: 'maseok_2_2_avoid_v2',
    seating: 'maseok_2_2_seating_v2',
    roster: 'maseok_2_2_roster_v3',
    pairGender: 'maseok_2_2_pair_gender'
};

const ASSIGNMENT_ERROR = '현재 설정으로 배치 조건을 만족하는 자리를 찾지 못했습니다.';

class SeatingApp {
    constructor() {
        this.students = [];
        this.avoidPairs = [];
        this.adjacentPairs = [];
        this.desks = [];
        this.mode = 'random';
        this.pairGender = 'random';
        this.genderStart = 'F';
        this.isInvertedView = false;
        this.autoRevealTimer = null;
        this.dragDeskId = null;
        this.isShuffling = false;
        this.init();
    }

    init() {
        this.initDesks();
        this.loadLocalData();
        this.bindEvents();
        this.renderGrid();
        document.getElementById('versionLabel').textContent = 'v' + APP_VERSION;
        if (!this.students.length) this.openStudentModal();
    }

    initDesks() {
        this.desks = Array.from({length: ROWS * COLS}, (_, id) => ({
            id, row: Math.floor(id / COLS), col: id % COLS,
            enabled: true, studentId: null, isRevealed: false, fixedStudentId: null
        }));
    }

    loadLocalData() {
        try {
            const roster = JSON.parse(localStorage.getItem(KEYS.roster));
            const students = roster ? roster.students : JSON.parse(localStorage.getItem(KEYS.students));
            const avoidPairs = roster ? roster.avoidPairs : JSON.parse(localStorage.getItem(KEYS.avoid));
            this.students = Array.isArray(students) ? students : [];
            this.avoidPairs = Array.isArray(avoidPairs) ? avoidPairs : [];
            this.adjacentPairs = Array.isArray(roster?.adjacentPairs) ? roster.adjacentPairs : [];
            this.pairGender = localStorage.getItem(KEYS.pairGender) === 'same' ? 'same' : 'random';
            const seating = JSON.parse(localStorage.getItem(KEYS.seating));
            if (Array.isArray(seating) && seating.length === ROWS * COLS) {
                this.desks = this.desks.map((base, i) => ({...base, ...seating[i], id:i, row:base.row, col:base.col}));
            }
        } catch {
            this.setStatus('저장된 설정을 읽지 못했습니다. 명단과 자리를 확인해 주세요.', 'warning');
        }
        this.cleanSeating();
    }

    saveData() {
        localStorage.setItem(KEYS.seating, JSON.stringify(this.desks));
    }

    cleanSeating() {
        const valid = new Set(this.students.map(s => s.id));
        const seen = new Set();
        this.desks.forEach(d => {
            if (!valid.has(String(d.studentId)) || seen.has(String(d.studentId))) d.studentId = null;
            if (d.studentId !== null) { d.studentId = String(d.studentId); seen.add(d.studentId); }
            if (d.studentId !== null) d.isRevealed = true;
            if (!valid.has(String(d.fixedStudentId))) d.fixedStudentId = null;
            if (!d.enabled) { d.studentId = null; d.fixedStudentId = null; }
        });
    }

    parseGender(value) {
        const v = String(value || '').trim().toUpperCase();
        if (['여', '여자', 'F'].includes(v)) return 'F';
        if (['남', '남자', 'M'].includes(v)) return 'M';
        return null;
    }

    normalizedPair(a, b) {
        return String(a) < String(b) ? [String(a), String(b)] : [String(b), String(a)];
    }

    avoids(a, b) {
        const key = this.normalizedPair(a, b).join('|');
        return this.avoidPairs.some(p => this.normalizedPair(p[0], p[1]).join('|') === key);
    }

    setStatus(message, kind = '') {
        const el = document.getElementById('appStatus');
        el.textContent = message;
        el.className = 'sync-line ' + kind;
    }

    shuffled(items) {
        const a = [...items];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    desiredGender(desk) {
        if (this.mode === 'col_gender') {
            const even = desk.col % 2 === 0;
            return even ? this.genderStart : (this.genderStart === 'F' ? 'M' : 'F');
        }
        if (this.mode === 'row_gender') {
            const even = desk.row % 2 === 0;
            return even ? this.genderStart : (this.genderStart === 'F' ? 'M' : 'F');
        }
        return null;
    }

    geometryConflict(a, b) {
        const dr = Math.abs(a.row - b.row);
        const dc = Math.abs(a.col - b.col);
        // Every desk is an independent seat. In random mode, all eight
        // immediately surrounding seats are too close for an avoidance pair.
        if (this.mode === 'random' || this.mode === 'pair') return dr <= 1 && dc <= 1;
        // In gender-line modes, only the immediately adjacent seat in the
        // same front-to-back line is prohibited.
        return dc === 0 && dr <= 1;
    }

    assignmentConflict(studentId, desk, assigned) {
        for (const [deskId, otherId] of assigned) {
            if (deskId === desk.id) continue;
            if (this.adjacentPairs.some(p => p.includes(studentId) && p.includes(otherId))) {
                const other = this.desks[deskId];
                if (Math.abs(desk.row - other.row) + Math.abs(desk.col - other.col) !== 1) return true;
            }
        }
        // A fixed seat takes priority over avoidance rules for either student.
        if (String(desk.fixedStudentId) === String(studentId)) return false;
        for (const [deskId, otherId] of assigned) {
            if (String(this.desks[deskId].fixedStudentId) === String(otherId)) continue;
            if (this.avoids(studentId, otherId) && this.geometryConflict(desk, this.desks[deskId])) return true;
        }
        return false;
    }

    solveAssignment({enforceRules = true} = {}) {
        if (!this.students.length) return {error:'명단 관리에서 학생을 먼저 등록해 주세요.'};
        const active = this.desks.filter(d => d.enabled);
        if (active.length < this.students.length) return {error:'활성 책상 수가 학생 수보다 적습니다.'};
        const validIds = new Set(this.students.map(s => s.id));
        const assigned = new Map();
        const fixedStudents = new Set();
        for (const desk of active) {
            if (!desk.fixedStudentId) continue;
            const sid = String(desk.fixedStudentId);
            if (!validIds.has(sid) || fixedStudents.has(sid)) return {error:'고정석 정보가 중복되었거나 유효하지 않습니다.'};
            assigned.set(desk.id, sid); fixedStudents.add(sid);
        }
        // Preview rounds use only fixed seats, without gender or avoidance rules.
        if (!enforceRules) {
            const students = this.shuffled(this.students.filter(s => !fixedStudents.has(s.id)));
            const seats = this.shuffled(active.filter(d => !assigned.has(d.id)));
            students.forEach((student, index) => assigned.set(seats[index].id, student.id));
            return {assigned};
        }
        for (const [id, sid] of assigned) {
            if (this.assignmentConflict(sid, this.desks[id], assigned)) {
                return {error:ASSIGNMENT_ERROR};
            }
        }
        const degree = id => this.avoidPairs.filter(p => p.includes(id)).length +
            this.adjacentPairs.filter(p => p.includes(id)).length * 10;
        const remaining = this.shuffled(this.students.filter(s => !fixedStudents.has(s.id)))
            .sort((a,b) => degree(b.id) - degree(a.id));
        const openIds = active.filter(d => !assigned.has(d.id)).map(d => d.id);
        const placedStudents = new Set(fixedStudents);
        const linkedToPlaced = id => this.adjacentPairs.some(p => p.includes(id) && p.some(other => other !== id && placedStudents.has(other)));
        const isPaired = this.mode === 'pair';
        const sameGender = isPaired && this.pairGender === 'same';
        const pairs = sameGender ? active.filter(d => d.col % 2 === 0 && this.desks[d.id + 1].enabled) : [];
        const genders = sameGender ? new Map(this.students.map(s => [s.id, s.gender])) : null;
        const girls = sameGender ? this.students.filter(s => s.gender === 'F').length : 0;
        const empty = active.length - this.students.length;
        // A full set of paired seats with two odd gender counts needs exactly one mixed pair.
        const mixedLimit = empty === 0 && pairs.length * 2 === active.length ? girls % 2 : 0;
        const pairsFit = () => {
            if (!sameGender) return true;
            let mixed = 0;
            const remaining = {F:girls, M:this.students.length - girls};
            const matesNeeded = {F:0, M:0};
            for (const id of placedStudents) remaining[genders.get(id)]--;
            for (const desk of pairs) {
                const a = genders.get(assigned.get(desk.id));
                const b = genders.get(assigned.get(desk.id + 1));
                if (a && b && a !== b) mixed++;
                if (Boolean(a) !== Boolean(b)) matesNeeded[a || b]++;
            }
            const shortfall = Math.max(0, matesNeeded.F - remaining.F) + Math.max(0, matesNeeded.M - remaining.M);
            return mixed <= mixedLimit && shortfall <= empty + mixedLimit - mixed;
        };
        let steps = 0;
        const place = index => {
            if (index >= remaining.length) return true;
            if (++steps > 250000) return false;
            const student = remaining.filter(s => !placedStudents.has(s.id))
                .sort((a, b) => Number(linkedToPlaced(b.id)) - Number(linkedToPlaced(a.id)) || degree(b.id) - degree(a.id))[0];
            const candidates = this.shuffled(openIds.filter(id => !assigned.has(id)))
                .sort((a,b) => {
                    if (isPaired) {
                        const rank = id => {
                            const mate = assigned.get(id ^ 1);
                            if (!mate) return this.desks[id ^ 1].enabled ? 1 : 2;
                            return sameGender && genders.get(mate) !== student.gender ? 3 : 0;
                        };
                        return rank(a) - rank(b);
                    }
                    const ga = this.desiredGender(this.desks[a]);
                    const gb = this.desiredGender(this.desks[b]);
                    return (ga !== null && ga !== student.gender) - (gb !== null && gb !== student.gender);
                });
            for (const id of candidates) {
                const desk = this.desks[id];
                if (this.assignmentConflict(student.id, desk, assigned)) continue;
                assigned.set(id, student.id);
                placedStudents.add(student.id);
                const hasRoom = remaining.every(s => placedStudents.has(s.id) || !linkedToPlaced(s.id) ||
                    openIds.some(next => !assigned.has(next) && !this.assignmentConflict(s.id, this.desks[next], assigned)));
                if (hasRoom && pairsFit() && place(index + 1)) return true;
                placedStudents.delete(student.id);
                assigned.delete(id);
            }
            return false;
        };
        return pairsFit() && place(0) ? {assigned} : {error:ASSIGNMENT_ERROR};
    }

    runAssignment(announce = true, {enforceRules = true, persist = true} = {}) {
        this.stopAutoReveal();
        const result = this.solveAssignment({enforceRules});
        if (result.error) {
            alert(result.error + (result.error === ASSIGNMENT_ERROR ? '\n배치 모드, 고정석 또는 빈자리를 조정해 주세요.' : ''));
            return false;
        }
        this.desks.forEach(d => {
            d.studentId = result.assigned.get(d.id) || null;
            d.isRevealed = Boolean(d.studentId);
        });
        if (persist) this.saveData();
        this.renderGrid();
        if (announce) {
            this.setStatus('자리 배치를 완료했습니다.', 'success');
            window.sounds?.playTick?.(1.2);
        }
        return true;
    }

    async runRepeatedAssignment() {
        if (this.isShuffling) return;
        if (!this.students.length) { this.openStudentModal(); return; }
        const input = document.getElementById('shuffleRepeatCount');
        const count = Number(input.value);
        if (!Number.isInteger(count) || count < 1 || count > 30) {
            alert('재배치 횟수는 1회부터 30회 사이로 입력해 주세요.');
            input.focus();
            return;
        }
        const previousSeating = this.desks.map(d => ({...d}));
        const controls = [...document.querySelectorAll('.mode-btn, #btnToggleGenderStart, #pairGender, #btnShuffle, #shuffleRepeatCount, #btnManageStudents, #btnFixedSeats, #btnPrint, #btnSaveStudents, #btnApplyFixed, #btnClearFixed')];
        const disabledStates = controls.map(control => control.disabled);
        let completed = false;
        this.isShuffling = true;
        controls.forEach(control => control.disabled = true);
        document.getElementById('deskGrid').setAttribute('aria-busy', 'true');
        document.body.classList.add('is-shuffling');
        try {
            for (let i = 1; i <= count; i++) {
                const isFinal = i === count;
                if (!this.runAssignment(false, {enforceRules:isFinal, persist:isFinal})) return;
                this.setStatus('랜덤 재배치 중… ' + i + ' / ' + count + '회', 'loading');
                window.sounds?.playTick?.(1 + i / count * 0.5);
                if (i < count) await new Promise(resolve => setTimeout(resolve, 420));
            }
            completed = true;
            this.setStatus(count + '회 재배치 완료 · 마지막 결과를 저장했습니다.', 'success');
        } finally {
            // Keep the last saved layout if the final rules cannot be satisfied.
            if (!completed) {
                this.desks = previousSeating;
                this.setStatus('재배치를 완료하지 못해 이전 자리 배치를 유지했습니다.', 'warning');
            }
            this.isShuffling = false;
            controls.forEach((control, index) => control.disabled = disabledStates[index]);
            document.getElementById('deskGrid').setAttribute('aria-busy', 'false');
            document.body.classList.remove('is-shuffling');
            this.renderGrid();
        }
    }

    renderGrid() {
        const grid = document.getElementById('deskGrid');
        const isPaired = this.mode === 'pair';
        grid.classList.toggle('paired', isPaired);
        grid.innerHTML = '';
        // Keep private placement rules out of the shared classroom display.
        this.desks.forEach(desk => {
            const card = this.createDeskElement(desk);
            card.style.gridColumn = String(desk.col + 1 + (isPaired ? Math.floor(desk.col / 2) : 0));
            card.style.gridRow = String(desk.row + 1);
            grid.appendChild(card);
        });
        this.updateStats();
    }

    createDeskElement(desk) {
        const student = this.students.find(s => s.id === desk.studentId);
        const card = document.createElement('div');
        card.className = 'desk-card' + (desk.isRevealed ? ' revealed' : '') +
            (!desk.enabled ? ' disabled' : '') + (desk.fixedStudentId ? ' pinned' : '') +
            (student ? (student.gender === 'M' ? ' gender-boy' : ' gender-girl') : '');
        card.dataset.id = desk.id;
        card.draggable = Boolean(student && desk.enabled);
        const safeName = student ? this.escapeHtml(student.name) : (desk.enabled ? '미배치' : '빈자리');
        card.innerHTML = '<div class="desk-card-inner">' +
            '<div class="card-face card-back"><span class="seat-num-badge">' + (desk.row + 1) + '줄 ' + (desk.col + 1) + '번</span><div class="mystery-icon">?</div><div class="mystery-hint">눌러서 공개</div></div>' +
            '<div class="card-face card-front"><div class="card-header-row"><span class="seat-id">' + (desk.row + 1) + '줄 ' + (desk.col + 1) + '번</span>' +
            (student ? '<span class="gender-badge ' + (student.gender === 'M' ? 'boy">남' : 'girl">여') + '</span>' : '') + '</div>' +
            '<div class="student-main-info"><div class="student-name">' + safeName + '</div>' +
            (student ? '<div class="student-num">' + this.escapeHtml(student.number) + '</div>' : '') + '</div>' +
            '<div class="card-footer-row"><button class="pin-icon" title="고정/해제">' + (desk.fixedStudentId ? '📌' : '📍') + '</button></div></div></div>';
        card.addEventListener('click', e => {
            if (e.target.closest('.pin-icon')) return;
            if (!desk.enabled) { desk.enabled = true; this.saveData(); this.renderGrid(); return; }
            if (!desk.studentId) return;
        });
        card.querySelector('.pin-icon')?.addEventListener('click', e => {
            e.stopPropagation();
            if (!desk.studentId) return;
            desk.fixedStudentId = desk.fixedStudentId ? null : desk.studentId;
            this.saveData(); this.renderGrid(); this.setStatus(desk.fixedStudentId ? '선택한 학생을 이 자리에 고정했습니다.' : '고정석을 해제했습니다.', 'success');
        });
        card.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (desk.studentId && desk.enabled && !confirm('이 책상을 빈자리로 바꾸면 현재 학생의 배치가 해제됩니다. 계속할까요?')) return;
            desk.enabled = !desk.enabled; desk.studentId = null; desk.fixedStudentId = null; desk.isRevealed = false;
            this.saveData(); this.renderGrid();
        });
        card.addEventListener('dragstart', () => { this.dragDeskId = desk.id; card.classList.add('dragging'); });
        card.addEventListener('dragend', () => { this.dragDeskId = null; card.classList.remove('dragging'); });
        card.addEventListener('dragover', e => { if (desk.enabled) { e.preventDefault(); card.classList.add('drag-over'); } });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', e => { e.preventDefault(); card.classList.remove('drag-over'); this.moveAndPin(this.dragDeskId, desk.id); });
        return card;
    }

    moveAndPin(fromId, toId) {
        if (fromId === null || fromId === toId || !this.desks[toId].enabled) return;
        const from = this.desks[fromId], to = this.desks[toId];
        const moving = from.studentId, displaced = to.studentId;
        if (!moving) return;
        if (from.fixedStudentId === moving) from.fixedStudentId = null;
        if (to.fixedStudentId === displaced) to.fixedStudentId = null;
        to.studentId = moving; to.fixedStudentId = moving; to.isRevealed = true;
        from.studentId = displaced; from.isRevealed = Boolean(displaced);
        this.saveData(); this.renderGrid();
        this.setStatus('이동한 학생을 새 자리에 고정했습니다.', 'success');
    }

    currentConflictDeskIds() {
        const result = new Set();
        const occupied = this.desks.filter(d => d.enabled && d.studentId);
        for (let i = 0; i < occupied.length; i++) for (let j = i + 1; j < occupied.length; j++) {
            if (this.assignmentConflict(occupied[i].studentId, occupied[i], new Map([[occupied[j].id, occupied[j].studentId]]))) {
                result.add(occupied[i].id); result.add(occupied[j].id);
            }
        }
        return result;
    }

    updateStats() {
        const boys = this.students.filter(s => s.gender === 'M').length;
        const girls = this.students.length - boys;
        const fixed = this.desks.filter(d => d.fixedStudentId).length;
        document.getElementById('statInfo').innerHTML = '학생 <span class="stat-value">' + this.students.length + '명</span> · 남 ' + boys + ' / 여 ' + girls + ' · 고정 ' + fixed;
        const assigned = this.desks.filter(d => d.enabled && d.studentId);
        const revealed = assigned.filter(d => d.isRevealed).length;
        const percent = assigned.length ? Math.round(revealed / assigned.length * 100) : 0;
        document.getElementById('revealProgressFill').style.width = percent + '%';
        document.getElementById('revealProgressText').textContent = revealed + '/' + assigned.length + ' (' + percent + '%)';
    }

    openModal(id) { document.getElementById(id).classList.add('active'); }
    closeModal(id) { document.getElementById(id).classList.remove('active'); }

    openStudentModal() {
        document.getElementById('studentInputArea').value = this.students.map(s => s.number + ' ' + s.name + ' ' + (s.gender === 'M' ? '남' : '여')).join('\n');
        document.getElementById('avoidInputArea').value = this.avoidPairs.map(pair => pair.join(' ')).join('\n');
        document.getElementById('adjacentInputArea').value = this.adjacentPairs.map(pair => pair.join(' ')).join('\n');
        document.getElementById('rosterError').textContent = '';
        this.openModal('studentModal');
        document.getElementById('studentInputArea').focus();
    }

    saveStudentsFromModal() {
        const rows = id => document.getElementById(id).value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        try {
            const students = rows('studentInputArea').map((line, i) => {
                const fields = line.split(/[,\s]+/);
                const number = /^\d+$/.test(fields[0]) ? fields.shift() : String(i + 1);
                const gender = this.parseGender(fields.pop());
                const name = fields.join(' ');
                if (!name || !gender) throw new Error('명단 ' + (i + 1) + '번째 항목의 이름과 성별을 확인해 주세요.');
                return {id:number, number, name, gender};
            });
            if (students.length > ROWS * COLS) throw new Error('학생은 최대 30명까지 입력할 수 있습니다.');
            const ids = new Set(students.map(s => s.id));
            if (ids.size !== students.length) throw new Error('중복된 학번이 있습니다.');
            const readPairs = (id, label) => {
                const pairs = rows(id).map((line, i) => {
                    const numbers = line.split(/[,\s]+/);
                    const [a, b] = numbers;
                    if (numbers.length !== 2 || a === b || !ids.has(a) || !ids.has(b)) {
                        throw new Error(label + ' ' + (i + 1) + '번째 항목에 서로 다른 학생의 학번 두 개를 입력해 주세요.');
                    }
                    return this.normalizedPair(a, b);
                });
                return [...new Map(pairs.map(pair => [pair.join('|'), pair])).values()];
            };
            const avoidPairs = readPairs('avoidInputArea', '기피 학생');
            const adjacentPairs = readPairs('adjacentInputArea', '붙는 학생');
            const avoided = new Set(avoidPairs.map(pair => pair.join('|')));
            if (adjacentPairs.some(pair => avoided.has(pair.join('|')))) {
                throw new Error('같은 학생 쌍을 기피 학생과 붙는 학생에 함께 등록할 수 없습니다.');
            }
            localStorage.setItem(KEYS.roster, JSON.stringify({students, avoidPairs, adjacentPairs}));
            localStorage.removeItem(KEYS.students);
            localStorage.removeItem(KEYS.avoid);
            this.students = students;
            this.avoidPairs = avoidPairs;
            this.adjacentPairs = adjacentPairs;
        } catch (error) {
            document.getElementById('rosterError').textContent = error.message;
            return;
        }
        this.cleanSeating();
        this.saveData();
        this.closeModal('studentModal');
        this.renderGrid();
        this.setStatus('명단과 배치 조건을 저장했습니다.', 'success');
    }

    openFixedModal() {
        const studentSelect = document.getElementById('fixedStudentSelect');
        studentSelect.innerHTML = this.students.map(s => '<option value="' + this.escapeHtml(s.id) + '">' + this.escapeHtml(s.name) + ' (' + this.escapeHtml(s.number) + ')</option>').join('');
        const seatSelect = document.getElementById('fixedSeatSelect');
        seatSelect.innerHTML = this.desks.filter(d => d.enabled).map(d => '<option value="' + d.id + '">' + (d.row + 1) + '줄 ' + (d.col + 1) + '번</option>').join('');
        this.renderFixedList(); this.openModal('fixedModal');
    }

    renderFixedList() {
        const fixed = this.desks.filter(d => d.fixedStudentId).map(d => {
            const s = this.students.find(st => st.id === d.fixedStudentId);
            return s ? '<span class="fixed-chip">' + this.escapeHtml(s.name) + ' · ' + (d.row + 1) + '줄 ' + (d.col + 1) + '번</span>' : '';
        }).join('');
        document.getElementById('fixedList').innerHTML = fixed || '<span class="input-hint">고정된 학생이 없습니다.</span>';
    }

    applyFixedSelection() {
        const sid = document.getElementById('fixedStudentSelect').value;
        const seat = document.getElementById('fixedSeatSelect').value;
        if (!sid || !seat) return;
        const targetId = Number(seat);
        let from = this.desks.find(d => d.studentId === sid);
        if (!from) {
            from = this.desks.find(d => d.enabled && !d.studentId);
            if (!from) { alert('학생을 옮길 빈자리가 없습니다. 먼저 자리를 배치해 주세요.'); return; }
            from.studentId = sid;
        }
        this.moveAndPin(from.id, targetId);
        if (from.id === targetId) { from.fixedStudentId = sid; this.saveData(); this.renderGrid(); }
        this.renderFixedList();
    }

    revealAll(value = true) {
        this.stopAutoReveal();
        this.desks.forEach(d => { if (d.enabled && d.studentId) d.isRevealed = value; });
        this.saveData(); this.renderGrid();
    }

    startAutoReveal() {
        if (this.autoRevealTimer) { this.stopAutoReveal(); return; }
        const queue = this.shuffled(this.desks.filter(d => d.enabled && d.studentId && !d.isRevealed));
        if (!queue.length) return;
        const next = () => {
            const desk = queue.shift();
            if (!desk) { this.autoRevealTimer = null; window.sounds?.playFanfare?.(); return; }
            desk.isRevealed = true; this.saveData(); this.renderGrid();
            this.autoRevealTimer = setTimeout(next, 550);
        };
        next();
    }

    stopAutoReveal() {
        if (this.autoRevealTimer) clearTimeout(this.autoRevealTimer);
        this.autoRevealTimer = null;
    }

    setUpdateUi(message, kind = '') {
        const box = document.getElementById('updateStatusBox');
        box.textContent = message;
        box.className = 'update-status-box ' + kind;
    }

    async openUpdateModal() {
        this.openModal('updateModal');
        if (!window.desktopUpdater) {
            this.setUpdateUi('설치된 Windows 앱에서 업데이트를 확인할 수 있습니다.');
            return;
        }
        const status = await window.desktopUpdater.getStatus();
        if (status && ['available', 'downloading', 'downloaded', 'install-error'].includes(status.type)) {
            this.renderUpdateStatus(status);
        } else {
            await this.checkDesktopUpdate();
        }
    }

    async checkDesktopUpdate() {
        if (!window.desktopUpdater) return;
        try {
            const result = await window.desktopUpdater.check();
            if (!result.ok) this.renderUpdateStatus({type:'error', message:result.message});
        } catch {
            this.renderUpdateStatus({type:'error', message:'업데이트 서비스에 연결하지 못했습니다. 앱을 다시 실행해 주세요.'});
        }
    }

    bindUpdaterEvents() {
        if (!window.desktopUpdater) return;
        window.desktopUpdater.onStatus(status => this.renderUpdateStatus(status));
    }

    renderUpdateStatus(status) {
        const download = document.getElementById('btnDownloadUpdate');
        const install = document.getElementById('btnInstallUpdate');
        const progress = document.getElementById('updateProgress');
        download.hidden = status.type !== 'available';
        install.hidden = status.type !== 'install-error';
        progress.hidden = status.type !== 'downloading';
        document.getElementById('btnRefreshUpdates').hidden = ['checking', 'available', 'downloading', 'downloaded', 'install-error'].includes(status.type);
        if (status.type === 'downloading' && this.updateType !== 'downloading') this.openModal('updateModal');
        this.updateType = status.type;
        if (status.type === 'checking') this.setUpdateUi('최신 버전을 확인하는 중…', 'loading');
        if (status.type === 'available') this.setUpdateUi('새 버전 v' + status.version + '을 사용할 수 있습니다.', 'success');
        if (status.type === 'not-available') this.setUpdateUi('현재 버전 v' + APP_VERSION + '에서 설치할 새 업데이트가 없습니다.', 'success');
        if (status.type === 'downloading') {
            const percent = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
            document.getElementById('updateProgressFill').style.width = percent + '%';
            this.setUpdateUi('업데이트 다운로드 중… ' + percent + '%', 'loading');
        }
        if (status.type === 'downloaded') this.setUpdateUi('다운로드 완료. 앱을 재시작합니다.', 'success');
        if (status.type === 'error' || status.type === 'install-error') this.setUpdateUi(status.message || '업데이트 중 오류가 발생했습니다.', 'error');
    }

    toggleView() {
        this.isInvertedView = !this.isInvertedView;
        document.body.classList.toggle('view-inverted', this.isInvertedView);
        document.getElementById('btnToggleView').textContent = this.isInvertedView ? '시점: 학생 기준' : '시점: 교사 기준';
    }

    escapeHtml(value) {
        const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML;
    }

    bindEvents() {
        this.bindUpdaterEvents();
        const pairGender = document.getElementById('pairGender');
        pairGender.value = this.pairGender;
        pairGender.addEventListener('change', () => {
            this.pairGender = pairGender.value;
            localStorage.setItem(KEYS.pairGender, this.pairGender);
        });
        document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(b => {
                b.classList.toggle('active', b === btn);
                b.setAttribute('aria-pressed', String(b === btn));
            });
            this.mode = btn.dataset.mode;
            const toggle = document.getElementById('btnToggleGenderStart');
            toggle.hidden = this.mode === 'random' || this.mode === 'pair';
            document.getElementById('pairOptions').hidden = this.mode !== 'pair';
            this.renderGrid();
        }));
        document.getElementById('btnToggleGenderStart').addEventListener('click', e => {
            this.genderStart = this.genderStart === 'F' ? 'M' : 'F';
            e.currentTarget.textContent = '시작: ' + (this.genderStart === 'F' ? '여학생' : '남학생');
        });
        document.getElementById('btnShuffle').addEventListener('click', () => this.runRepeatedAssignment());
        document.getElementById('btnManageStudents').addEventListener('click', () => this.openStudentModal());
        document.getElementById('btnFixedSeats').addEventListener('click', () => this.openFixedModal());
        document.getElementById('btnSaveStudents').addEventListener('click', () => this.saveStudentsFromModal());
        document.getElementById('btnApplyFixed').addEventListener('click', () => this.applyFixedSelection());
        document.getElementById('btnClearFixed').addEventListener('click', () => {
            this.desks.forEach(d => d.fixedStudentId = null); this.saveData(); this.renderGrid(); this.renderFixedList();
        });
        document.getElementById('btnToggleView').addEventListener('click', () => this.toggleView());
        document.getElementById('btnCheckUpdate').addEventListener('click', () => this.openUpdateModal());
        document.getElementById('btnRefreshUpdates').addEventListener('click', () => this.checkDesktopUpdate());
        document.getElementById('btnDownloadUpdate').addEventListener('click', async e => {
            const button = e.currentTarget;
            button.disabled = true;
            const result = await window.desktopUpdater.download();
            button.disabled = false;
            if (!result.ok) this.renderUpdateStatus({type:'error', message:result.message});
        });
        document.getElementById('btnInstallUpdate').addEventListener('click', async () => {
            const result = await window.desktopUpdater.install();
            if (!result.ok) this.setUpdateUi(result.message, 'error');
        });
        document.getElementById('btnPrint').addEventListener('click', () => window.print());
        document.getElementById('btnSoundToggle').addEventListener('click', e => {
            const muted = window.sounds?.toggleMute?.(); e.currentTarget.textContent = muted ? '🔇' : '🔊';
        });
        document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => this.closeModal(btn.dataset.close)));
        document.querySelectorAll('.modal-backdrop').forEach(modal => modal.addEventListener('click', e => { if (e.target === modal) this.closeModal(modal.id); }));
        window.addEventListener('keydown', e => {
            if (e.code !== 'Space' || ['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName)) return;
            e.preventDefault();
            const desk = this.desks.find(d => d.enabled && d.studentId && !d.isRevealed);
            if (desk) { desk.isRevealed = true; this.saveData(); this.renderGrid(); }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new SeatingApp(); });
