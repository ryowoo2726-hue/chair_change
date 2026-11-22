const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    const nodes = new Map();
    const controls = Array.from({length: 4}, () => ({disabled: false}));
    const classes = new Set();
    const stored = new Map();
    const alerts = [];
    const rounds = [];
    let saves = 0;
    const document = {
        body: {classList: {add: value => classes.add(value), remove: value => classes.delete(value)}},
        addEventListener() {},
        querySelectorAll: () => controls,
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, {
                value: '5', innerHTML: '', style: {}, children: [],
                classList: {add() {}, remove() {}, toggle() {}},
                setAttribute() {}, focus() {}, appendChild(card) { this.children.push(card); }
            });
            return nodes.get(id);
        }
    };
    const context = vm.createContext({
        document, window: {}, alert: message => alerts.push(message),
        localStorage: {
            getItem: key => stored.get(key) ?? null,
            setItem(key, value) { stored.set(key, value); saves++; },
            removeItem(key) { stored.delete(key); }
        },
        setTimeout: callback => { callback(); return 1; }, clearTimeout() {}
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8') +
        '\nglobalThis.app = Object.create(SeatingApp.prototype);' +
        '\napp.students = Array.from({length:30}, (_, i) => ({id:String(101 + i), number:String(101 + i), name:`학생${i + 1}`, gender:i < 15 ? "F" : "M"}));' +
        '\napp.avoidPairs = [["113", "112"], ["115", "109"], ["129", "109"]];' +
        '\napp.adjacentPairs = [];' +
        '\napp.mode = "random"; app.genderStart = "F"; app.isShuffling = false; app.initDesks();', context);
    const app = context.app;
    app.updateStats = () => {};
    app.createDeskElement = (desk, conflict) => ({style: {}, conflict, deskId: desk.id});
    const render = app.renderGrid.bind(app);
    app.renderGrid = () => {
        document.getElementById('deskGrid').children = [];
        render();
        rounds.push({
            shuffling: app.isShuffling,
            conflicts: document.getElementById('deskGrid').children.filter(card => card.conflict).length
        });
    };
    return {app, document, controls, classes, stored, alerts, rounds, saveCount: () => saves};
}

function assertValid(app, assigned, enforceRules) {
    assert.equal(assigned.size, app.students.length);
    assert.equal(new Set(assigned.values()).size, app.students.length);
    for (const [id, studentId] of assigned) {
        assert.equal(app.desks[id].enabled, true);
        if (enforceRules) {
            const others = new Map(assigned);
            others.delete(id);
            assert.equal(app.assignmentConflict(studentId, app.desks[id], others), false);
        }
    }
    for (const desk of app.desks) {
        if (desk.fixedStudentId) assert.equal(assigned.get(desk.id), desk.fixedStudentId);
    }
}

test('avoidance is symmetric in either order', () => {
    const {app} = fixture();
    assert.equal(app.avoids('112', '113'), true);
    assert.equal(app.avoids('113', '112'), true);
    assert.equal(app.avoids('101', '102'), false);
});

test('final layouts keep every student and fixed seat and satisfy each mode’s distances', () => {
    const {app} = fixture();
    app.desks[0].fixedStudentId = '101';
    app.desks[29].fixedStudentId = '130';
    for (const mode of ['random', 'col_gender', 'row_gender', 'pair']) {
        app.mode = mode;
        for (let attempt = 0; attempt < 40; attempt++) {
            const result = app.solveAssignment();
            assert.equal(result.error, undefined);
            assertValid(app, result.assigned, true);
        }
    }
});

test('preview rounds ignore avoidance and gender even when fixed seats conflict', () => {
    const {app} = fixture();
    app.mode = 'col_gender';
    app.desks[0].fixedStudentId = '113';
    app.desks[6].fixedStudentId = '112';
    assertValid(app, app.solveAssignment().assigned, true);
    app.assignmentConflict = app.desiredGender = () => { throw new Error('Preview applied a rule'); };
    assertValid(app, app.solveAssignment({enforceRules: false}).assigned, false);
});

test('fixed seats override avoidance on either side and unpinning restores the rule', () => {
    for (const mode of ['random', 'col_gender', 'row_gender']) {
        for (const fixedIds of [[0], [6], [0, 6]]) {
            const {app} = fixture();
            app.mode = mode;
            app.students = app.students.filter(s => ['112', '113'].includes(s.id));
            app.desks.forEach(desk => { desk.enabled = [0, 6].includes(desk.id); });
            app.desks[0].studentId = '112';
            app.desks[6].studentId = '113';
            fixedIds.forEach(id => { app.desks[id].fixedStudentId = app.desks[id].studentId; });
            assertValid(app, app.solveAssignment().assigned, true);
            assert.equal(app.currentConflictDeskIds().size, 0);
            for (const id of [0, 6]) {
                const otherId = id === 0 ? 6 : 0;
                assert.equal(app.assignmentConflict(app.desks[id].studentId, app.desks[id],
                    new Map([[otherId, app.desks[otherId].studentId]])), false);
            }
            fixedIds.forEach(id => { app.desks[id].fixedStudentId = null; });
            assert.match(app.solveAssignment().error, /배치 조건/);
            assert.equal(app.currentConflictDeskIds().size, 2);
        }
    }
});

test('disabled seats stay empty and spare enabled seats are allowed', () => {
    const {app} = fixture();
    app.students = app.students.slice(0, 20);
    app.desks.slice(25).forEach(desk => { desk.enabled = false; });
    for (const enforceRules of [true, false]) {
        assertValid(app, app.solveAssignment({enforceRules}).assigned, enforceRules);
    }
    app.desks.slice(15).forEach(desk => { desk.enabled = false; });
    assert.match(app.solveAssignment({enforceRules: false}).error, /학생 수보다/);
});

test('only the last of 1, 5, 10, or 30 rounds uses rules and saves; markers stay hidden', async () => {
    for (const count of [1, 5, 10, 30]) {
        const {app, document, rounds, controls, classes, stored, saveCount} = fixture();
        document.getElementById('shuffleRepeatCount').value = String(count);
        app.desks[0].fixedStudentId = '101';
        const flags = [];
        const solve = app.solveAssignment.bind(app);
        app.solveAssignment = options => { flags.push(options.enforceRules); return solve(options); };
        await app.runRepeatedAssignment();
        assert.deepEqual(flags, Array(count - 1).fill(false).concat(true));
        assert.equal(saveCount(), 1, 'Save seating exactly once');
        assert.equal(stored.get('maseok_2_2_seating_v2'), JSON.stringify(app.desks));
        assert.equal(rounds.filter(round => round.shuffling).length, count);
        assert.ok(rounds.every(round => round.conflicts === 0));
        assert.ok(controls.every(control => !control.disabled));
        assert.equal(app.isShuffling, false);
        assert.equal(classes.size, 0);
        assert.equal(app.currentConflictDeskIds().size, 0);
        assertValid(app, new Map(app.desks.filter(d => d.studentId).map(d => [d.id, d.studentId])), true);
    }
});

test('an impossible final layout restores previous seats and never saves preview results', async () => {
    const {app, controls, alerts, saveCount} = fixture();
    app.students = app.students.filter(s => ['112', '113'].includes(s.id));
    app.desks.slice(2).forEach(desk => { desk.enabled = false; });
    app.avoidPairs = [];
    app.runAssignment(false);
    app.avoidPairs = [['112', '113']];
    const before = JSON.stringify(app.desks);
    const savesBefore = saveCount();
    controls[1].disabled = true;
    await app.runRepeatedAssignment();
    assert.equal(JSON.stringify(app.desks), before);
    assert.equal(saveCount(), savesBefore);
    assert.equal(alerts.length, 1);
    assert.equal(controls[0].disabled, false);
    assert.equal(controls[1].disabled, true);
    assert.equal(app.isShuffling, false);
});

test('invalid counts cause no shuffle or saves', async () => {
    for (const count of ['0', '31', '1.5', '']) {
        const {app, document, alerts, saveCount} = fixture();
        document.getElementById('shuffleRepeatCount').value = count;
        await app.runRepeatedAssignment();
        assert.equal(alerts.length, 1);
        assert.equal(saveCount(), 0);
        assert.ok(app.desks.every(desk => desk.studentId === null));
    }
});

test('private relationships never mark seats or change move messages, including after reload', () => {
    const {app, document, rounds} = fixture();
    app.desks[0].studentId = '112';
    app.desks[2].studentId = '113';
    app.moveAndPin(2, 1);
    assert.equal(app.currentConflictDeskIds().size, 0);
    assert.equal(document.getElementById('appStatus').textContent, '이동한 학생을 새 자리에 고정했습니다.');
    app.renderGrid();
    assert.ok(rounds.every(round => round.conflicts === 0));
    app.desks[0].fixedStudentId = '112';
    app.runAssignment();
    assert.equal(app.solveAssignment().error, undefined);
});

test('together pairs sit exactly one orthogonal seat apart in every mode, including fixed partners', () => {
    const {app} = fixture();
    app.adjacentPairs = [['101', '102'], ['102', '103'], ['104', '105'], ['106', '107']];
    app.desks[0].fixedStudentId = '101';
    for (const mode of ['random', 'col_gender', 'row_gender', 'pair']) {
        app.mode = mode;
        for (let attempt = 0; attempt < 20; attempt++) {
            const result = app.solveAssignment();
            assert.equal(result.error, undefined);
            assertValid(app, result.assigned, true);
            const seats = new Map([...result.assigned].map(([id, sid]) => [sid, app.desks[id]]));
            for (const [a, b] of app.adjacentPairs) {
                assert.equal(Math.abs(seats.get(a).row - seats.get(b).row) + Math.abs(seats.get(a).col - seats.get(b).col), 1);
            }
        }
    }
});

test('together conditions reject diagonals, gaps and incompatible fixed seats; previews ignore them', () => {
    for (const seats of [[0, 7], [0, 2], [5, 6]]) {
        const {app} = fixture();
        app.students = app.students.slice(0, 2);
        app.avoidPairs = [];
        app.adjacentPairs = [['101', '102']];
        app.desks.forEach(d => { d.enabled = seats.includes(d.id); });
        assert.match(app.solveAssignment().error, /배치 조건/);
        app.desks[seats[0]].fixedStudentId = '101';
        app.desks[seats[1]].fixedStudentId = '102';
        assert.match(app.solveAssignment().error, /배치 조건/);
        assertValid(app, app.solveAssignment({enforceRules: false}).assigned, false);
    }
});

test('fresh profiles have no roster; local validation and reload preserve both types of rules and seats', () => {
    const {app, document, stored} = fixture();
    app.loadLocalData();
    assert.equal(app.students.length, 0);
    assert.equal(app.avoidPairs.length, 0);
    assert.match(app.solveAssignment().error, /먼저 등록/);

    app.openStudentModal();
    const input = id => document.getElementById(id);
    input('studentInputArea').value = '101 학생가 여\n102 학생나 남\n103 학생다 남';
    input('avoidInputArea').value = '103 101\n101 103';
    input('adjacentInputArea').value = '102 103';
    app.saveStudentsFromModal();
    assert.equal(app.runAssignment(), true);
    const before = JSON.stringify([...stored]);

    for (const invalid of ['101 103', '102 102', '102 404']) {
        input('adjacentInputArea').value = invalid;
        app.saveStudentsFromModal();
        assert.ok(input('rosterError').textContent);
        assert.equal(JSON.stringify([...stored]), before);
    }
    app.initDesks();
    app.loadLocalData();
    assert.equal(app.students.length, 3);
    assert.equal(JSON.stringify(app.avoidPairs), '[["101","103"]]');
    assert.equal(JSON.stringify(app.adjacentPairs), '[["102","103"]]');
    assert.equal(app.desks.filter(d => d.studentId).length, 3);
});

test('existing profiles keep saved students, avoidance and fixed seats', () => {
    const {app, stored} = fixture();
    app.desks[0].studentId = app.desks[0].fixedStudentId = '101';
    stored.set('maseok_2_2_students_v2', JSON.stringify(app.students));
    stored.set('maseok_2_2_avoid_v2', JSON.stringify(app.avoidPairs));
    app.saveData();
    app.initDesks();
    app.loadLocalData();
    assert.equal(app.students.length, 30);
    assert.equal(app.avoids('112', '113'), true);
    assert.equal(app.desks[0].fixedStudentId, '101');
});

test('same-gender pairs respect the existing constraints and only mix when a full room requires it', () => {
    const {app} = fixture();
    app.mode = 'pair';
    app.pairGender = 'same';
    app.desks[0].fixedStudentId = '101';
    app.adjacentPairs = [['101', '116'], ['119', '120']];
    const genders = new Map(app.students.map(s => [s.id, s.gender]));
    const mixedPairs = assigned => [...assigned].filter(([id, sid]) =>
        id % 2 === 0 && assigned.has(id + 1) && genders.get(sid) !== genders.get(assigned.get(id + 1))).length;
    for (const [size, expected] of [[30, 1], [29, 0], [28, 0]]) {
        app.students = app.students.slice(0, size);
        for (let attempt = 0; attempt < 10; attempt++) {
            const result = app.solveAssignment();
            assert.equal(result.error, undefined);
            assertValid(app, result.assigned, true);
            assert.equal(mixedPairs(result.assigned), expected);
        }
    }
});

test('random partners can sit together regardless of gender while same-gender previews remain random', () => {
    const {app} = fixture();
    app.students = app.students.filter(s => ['101', '102', '116', '117'].includes(s.id));
    app.desks.slice(4).forEach(d => { d.enabled = false; });
    app.desks[0].fixedStudentId = '101';
    app.desks[1].fixedStudentId = '116';
    app.mode = 'pair';
    app.pairGender = 'same';
    assert.match(app.solveAssignment().error, /배치 조건/);
    assertValid(app, app.solveAssignment({enforceRules:false}).assigned, false);
    app.pairGender = 'random';
    assertValid(app, app.solveAssignment().assigned, true);
});
