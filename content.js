/*eslint no-unused-vars:1*/
// Wordle Boss: counts the words still possible and beeps when you type a letter
// that can't go in the current square.
//
// Efficiency notes:
//  - no polling: waits for the board with a MutationObserver, then watches only
//    tiles' data-state attributes, so it recomputes exactly when tiles flip
//    (no fixed 1s/3s sleeps)
//  - recomputes the word count only when the set of finished rows changes
//  - beep check is O(1) per keystroke against precomputed constraints
//
// NYT DOM notes (Nov 2026): each tile wrapper holds the tile <div
// data-testid="tile" data-state=...> plus a visually-hidden <span> with
// screen-reader text ("1st letter, C, absent"). Read the letter from the tile
// div only -- the wrapper's textContent includes the hidden text.

const DEBUG = false
const log = (...args) => { if (DEBUG) console.log('wboss:', ...args) }
const FINAL_STATES = new Set(['absent', 'present', 'correct'])

async function main() {

const words = await (await fetch(chrome.runtime.getURL('words.json'))).json()
log('loaded', words.length, 'words')

// ---------- DOM access ----------

function findBoard() {
    // NYT uses CSS modules with hashed class names (e.g. Board-module_boardContainer__TBHNL),
    // so match on the stable prefix instead of the full class name
    const container = document.querySelector('[class*="Board-module_boardContainer"]')
    const board = container && container.children[0]
    if (!board || !board.querySelector('[data-testid="tile"]')) return null
    if (!document.querySelector('button[data-key]')) return null
    return board
}

function waitFor(fn) {
    return new Promise(resolve => {
        const found = fn()
        if (found) return resolve(found)
        const observer = new MutationObserver(() => {
            const found = fn()
            if (found) {
                observer.disconnect()
                resolve(found)
            }
        })
        observer.observe(document.documentElement, { childList: true, subtree: true })
    })
}

// rows of { letter, state }; re-queries the board in case the page re-rendered it
function readBoard() {
    const board = findBoard()
    if (!board) return []
    return Array.from(board.children).map(row =>
        Array.from(row.querySelectorAll('[data-testid="tile"]')).map(tile => ({
            letter: tile.textContent.trim().toLowerCase(),
            state: tile.getAttribute('data-state'),
        })))
}

const isFinished = row => row.length == 5 && row.every(t => FINAL_STATES.has(t.state))

// ---------- Wordle logic ----------

const CODE = { absent: 'a', present: 'p', correct: 'c' }

// the colors Wordle would show for `guess` if the answer were `answer`
// (handles repeated letters the way Wordle does)
function score(guess, answer) {
    const result = ['a', 'a', 'a', 'a', 'a']
    const unmatched = {}
    for (let i = 0; i < 5; i++) {
        if (guess[i] == answer[i]) result[i] = 'c'
        else unmatched[answer[i]] = (unmatched[answer[i]] || 0) + 1
    }
    for (let i = 0; i < 5; i++) {
        if (result[i] != 'c' && unmatched[guess[i]] > 0) {
            result[i] = 'p'
            unmatched[guess[i]]--
        }
    }
    return result.join('')
}

// a word is possible if it would have produced exactly the colors we saw
function filterWords(list, rows) {
    const checks = rows.map(row => ({
        guess: row.map(t => t.letter).join(''),
        pattern: row.map(t => CODE[t.state]).join(''),
    }))
    return list.filter(word => checks.every(c => score(c.guess, word) == c.pattern))
}

// what the finished rows tell us, for the per-keystroke beep check
function buildConstraints(rows) {
    const green = [null, null, null, null, null]
    const notAt = [new Set(), new Set(), new Set(), new Set(), new Set()]
    const maxCount = {} // letter -> most copies the answer can have
    for (const row of rows) {
        const shown = {}
        const grayed = new Set()
        row.forEach((t, i) => {
            if (t.state == 'correct') green[i] = t.letter
            else notAt[i].add(t.letter)
            if (t.state == 'absent') grayed.add(t.letter)
            else shown[t.letter] = (shown[t.letter] || 0) + 1
        })
        // a gray letter means the answer has exactly as many as were colored
        for (const l of grayed) {
            const n = shown[l] || 0
            maxCount[l] = maxCount[l] === undefined ? n : Math.min(maxCount[l], n)
        }
    }
    return { green, notAt, maxCount }
}

// true if `letter` can't possibly go in column `col`
function mustBeWrong(letter, col, { green, notAt, maxCount }) {
    if (green[col]) return green[col] != letter
    if (notAt[col].has(letter)) return true
    const max = maxCount[letter]
    if (max === undefined) return false
    // copies already pinned down as green in other columns
    const pinned = green.filter((g, i) => i != col && g == letter).length
    return pinned >= max
}

// ---------- state ----------

let rows = []            // finished rows
let constraints = buildConstraints([])
let lastKey = null       // finished rows, as a string, from the last update
let finished = false

function update() {
    const board = readBoard()
    const done = board.filter(isFinished)
    const key = done.map(r => r.map(t => t.letter + CODE[t.state]).join('')).join('|')
    if (key == lastKey) return
    lastKey = key
    rows = done
    constraints = buildConstraints(rows)

    const won = rows.some(r => r.every(t => t.state == 'correct'))
    if (won) {
        setBossTitle('Wordle Boss: Congratulations!')
        if (!finished) playRight()
        finished = true
    }
    else {
        finished = rows.length >= 6
        const possible = filterWords(words, rows)
        setBossTitle(`Wordle Boss: ${possible.length} words left`)
        log('possible:', possible.length <= 50 ? possible : possible.length)
    }
    dimAbsentKeys()
}

function dimAbsentKeys() {
    for (const key of document.querySelectorAll('button[data-key]')) {
        key.style.opacity = key.getAttribute('data-state') == 'absent' ? 0 : 1.0
    }
}

// called *before* the game handles the key (capture phase), so the letter
// isn't on the board yet
function checkLetter(letter) {
    if (finished) return
    const board = readBoard()
    const current = board.find(row => !isFinished(row))
    if (!current) return
    const col = current.filter(t => t.letter).length
    if (col >= 5) return
    if (mustBeWrong(letter, col, constraints)) {
        log('the letter must be wrong:', letter, 'column', col)
        playWrong()
    }
}

// ---------- status display ----------

// Find somewhere to show our status. The NYT header no longer has a visible title:
// its only <h1> is "visually-hidden" (screen readers only), so writing to it shows
// nothing. Instead, add our own element to the toolbar (a flex row: menu button,
// hidden h1, icon menu) as a flexible middle item, or above the game if the
// toolbar isn't there.
let bossTitleEl = null
function findTitleElement() {
    let el = document.getElementById('wboss-title')
    if (el) return el
    el = document.createElement('div')
    el.id = 'wboss-title'
    el.style.cssText = 'font-weight:bold;font-size:18px;white-space:nowrap;' +
        'color:var(--color-tone-1, inherit);'
    let toolbar = document.querySelector('header [data-testid="toolbar"]')
    if (toolbar) {
        // NYT styles every "toolbar div" as display:flex with height:100%; use a
        // block (so the ellipsis works) with auto height (so the toolbar centers it)
        el.style.cssText += 'display:block;height:auto;flex:1 1 auto;min-width:0;overflow:hidden;' +
            'text-overflow:ellipsis;text-align:left;padding:0 8px;'
        // put it just before the right-hand icon menu (or at the end)
        toolbar.insertBefore(el, toolbar.querySelector(':scope > menu'))
    }
    else {
        el.style.cssText += 'text-align:center;padding:6px 0;'
        let app = document.getElementById('wordle-app-game')
        app.parentNode.insertBefore(el, app)
    }
    return el
}
function setBossTitle(title) {
    try {
        // the page may re-render and replace the element we found
        if (!bossTitleEl || !bossTitleEl.isConnected) {
            bossTitleEl = findTitleElement()
        }
        bossTitleEl.textContent = title
    }
    catch (error) {
        console.log('wboss: failed to set title:', title, error)
    }
}

// ---------- audio ----------

async function playAudio(sound) {
    try {
        await sound.play()
    }
    catch (error) {
        log('could not play sound')
    }
}
function playWrong() {
    playAudio(Math.random() < 0.7 ? audioDontDoThat : audioDang)
}
function playRight() {
    playAudio(audioLooking)
}

const audioLucky = new Audio(chrome.runtime.getURL('audio/nap-luucky.mp3'))
const audioDang = new Audio(chrome.runtime.getURL('audio/nap-ddang.mp3'))
const audioDontDoThat = new Audio(chrome.runtime.getURL('audio/swluke01.mp3'))
const audioLooking = new Audio(chrome.runtime.getURL('audio/heres-looking.mp3'))

// ---------- wiring ----------

await waitFor(findBoard)
log('found game board')
setBossTitle('Wordle Boss')
update()

// recompute after tiles finish flipping (debounced: a row flips over ~2s)
let timer = null
new MutationObserver(() => {
    clearTimeout(timer)
    timer = setTimeout(update, 300)
}).observe(document.body, { attributes: true, attributeFilter: ['data-state'], subtree: true })

// physical keyboard (capture phase: runs before the game's own handler)
window.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key.length == 1 && /[a-z]/i.test(e.key)) checkLetter(e.key.toLowerCase())
}, true)

// on-screen keyboard (capture phase, delegated so a re-rendered keyboard still works)
document.addEventListener('click', e => {
    const key = e.target.closest && e.target.closest('button[data-key]')
    if (!key) return
    const letter = key.getAttribute('data-key')
    if (/^[a-z]$/.test(letter)) checkLetter(letter)
}, true)

log('running')
}
main()
