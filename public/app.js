import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    onSnapshot,
    runTransaction,
    setDoc,
    updateDoc,
    writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import {
    buildDeck,
    canUseStrategyHint,
    calcScore,
    getBestAction,
    groupLabel,
    isBlackjack,
    settleHand,
    shuffle,
    summarizeGroups,
} from './game-logic.js';

const firebaseConfig = {
    apiKey: 'AIzaSyCoqv8A0rYgKpsBgX4hsUpqziQgaCfP2AQ',
    authDomain: 'classroom-blackjack.firebaseapp.com',
    projectId: 'classroom-blackjack',
    storageBucket: 'classroom-blackjack.firebasestorage.app',
    messagingSenderId: '1022908396548',
    appId: '1:1022908396548:web:6254d2c45814c24c3b3151',
};

const MAX_CLASS_SIZE = 40;
const GAME_ID_LENGTH = 6;
const GAME_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ACTION_DEBOUNCE_MS = 250;

let db;
let auth;
let userId;
let gameId;
let isHost = false;
let localPlayerState = {};
let allPlayersState = {};
let currentGameState = {};
let unsubscribeGame = null;
let unsubscribePlayers = null;
let isDealing = false;
let isProcessingActions = false;
let actionProcessingQueued = false;
let isFinishingRound = false;
let autoDealTimer = null;
let actionBatchTimer = null;

const els = Object.fromEntries(
    [
        'join-screen', 'player-name-input', 'game-id-input', 'join-game-btn', 'create-game-btn',
        'connection-status', 'error-message', 'game-area', 'host-controls', 'game-id-display',
        'host-status', 'copy-code-btn', 'deal-hand-btn', 'force-deal-btn', 'show-summary-btn',
        'game-message', 'dealer-cards', 'dealer-score', 'player-area', 'local-player-name',
        'player-cards', 'player-score', 'player-bankroll', 'player-bet', 'player-status',
        'betting-controls', 'bet-amount', 'bet-amount-value', 'place-bet-btn', 'action-controls',
        'hit-btn', 'stand-btn', 'double-down-btn', 'show-odds-btn', 'all-players-area',
        'player-count', 'players-grid', 'summary-modal', 'summary-content', 'close-summary-btn',
    ].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]),
);

function gameRef(id = gameId) {
    return doc(db, 'games', id);
}

function hostStateRef(id = gameId) {
    return doc(db, 'games', id, 'private', 'host');
}

function playersRef(id = gameId) {
    return collection(db, 'games', id, 'players');
}

function playerRef(playerId = userId, id = gameId) {
    return doc(db, 'games', id, 'players', playerId);
}

function setError(message = '') {
    els.error_message.textContent = message;
}

function setGameMessage(message = '') {
    els.game_message.textContent = message;
    els.game_message.classList.toggle('hidden', !message);
}

function readableError(error, fallback) {
    console.error(error);
    if (error?.code === 'permission-denied') {
        return 'Firebase denied that action. Deploy the included Firestore rules and try again.';
    }
    if (error?.code === 'unavailable') return 'The game service is temporarily unavailable. Check the network and retry.';
    return fallback;
}

function randomGameId() {
    const randomValues = new Uint32Array(GAME_ID_LENGTH);
    crypto.getRandomValues(randomValues);
    return [...randomValues].map((value) => GAME_ID_ALPHABET[value % GAME_ID_ALPHABET.length]).join('');
}

function normalizeGameId(value) {
    return value.trim().toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, '').slice(0, GAME_ID_LENGTH);
}

async function initialize() {
    try {
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
        await auth.authStateReady();
        if (!auth.currentUser) await signInAnonymously(auth);
        userId = auth.currentUser.uid;

        const linkedGame = normalizeGameId(new URLSearchParams(window.location.search).get('game') ?? '');
        const savedHostGame = localStorage.getItem('classroomBlackjackHostGame');
        if (linkedGame || savedHostGame) els.game_id_input.value = linkedGame || savedHostGame;
        els.connection_status.textContent = 'Connected — no account required.';
        els.join_game_btn.disabled = false;
        els.create_game_btn.disabled = false;
    } catch (error) {
        els.connection_status.textContent = 'Unable to connect.';
        setError(readableError(error, 'Connection failed. Confirm Anonymous Authentication is enabled in Firebase.'));
    }
}

async function createGame() {
    setError();
    const hostName = els.player_name_input.value.trim();
    if (!hostName) {
        setError('Enter your name before creating a game.');
        return;
    }

    els.create_game_btn.disabled = true;
    try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const candidateId = randomGameId();
            try {
                await runTransaction(db, async (transaction) => {
                    const publicRef = gameRef(candidateId);
                    const privateRef = hostStateRef(candidateId);
                    const existing = await transaction.get(publicRef);
                    if (existing.exists()) throw new Error('GAME_CODE_COLLISION');

                    const now = Date.now();
                    transaction.set(publicRef, {
                        hostId: userId,
                        hostName,
                        state: 'waiting',
                        dealerCards: [],
                        dealerCardCount: 0,
                        dealerScore: null,
                        reveal: false,
                        createdAt: now,
                        updatedAt: now,
                    });
                    transaction.set(privateRef, {
                        deck: shuffle(buildDeck()),
                        dealerHand: [],
                    });
                });

                isHost = true;
                gameId = candidateId;
                localStorage.setItem('classroomBlackjackHostGame', candidateId);
                joinSession(candidateId);
                return;
            } catch (error) {
                if (error?.message !== 'GAME_CODE_COLLISION') throw error;
            }
        }
        throw new Error('Could not reserve a unique game code');
    } catch (error) {
        isHost = false;
        setError(readableError(error, 'Could not create the game. Please try again.'));
    } finally {
        els.create_game_btn.disabled = false;
    }
}

async function joinGame() {
    setError();
    const name = els.player_name_input.value.trim();
    const requestedGameId = normalizeGameId(els.game_id_input.value);
    els.game_id_input.value = requestedGameId;

    if (!name || requestedGameId.length !== GAME_ID_LENGTH) {
        setError('Enter your name and the 6-character game code.');
        return;
    }

    els.join_game_btn.disabled = true;
    try {
        const publicSnapshot = await getDoc(gameRef(requestedGameId));
        if (!publicSnapshot.exists()) {
            setError('Game not found. Check the code with your teacher.');
            return;
        }

        const publicGame = publicSnapshot.data();
        if (publicGame.hostId === userId) {
            isHost = true;
            localStorage.setItem('classroomBlackjackHostGame', requestedGameId);
            joinSession(requestedGameId);
            return;
        }

        isHost = false;
        const targetPlayerRef = playerRef(userId, requestedGameId);
        const existingPlayer = await getDoc(targetPlayerRef);
        if (existingPlayer.exists()) {
            joinSession(requestedGameId);
            return;
        }
        if (!['waiting', 'finished'].includes(publicGame.state)) {
            setError('A round is already in progress. Ask the teacher to let you join between rounds.');
            return;
        }
        const group = document.querySelector('input[name="group"]:checked').value;
        await setDoc(targetPlayerRef, {
            name,
            group,
            bankroll: 1000,
            bet: 0,
            hand: [],
            status: 'waiting',
            actionRequest: null,
            result: '',
        });
        joinSession(requestedGameId);
    } catch (error) {
        setError(readableError(error, 'Could not join the game. Please try again.'));
    } finally {
        els.join_game_btn.disabled = false;
    }
}

function clearSubscriptions() {
    unsubscribeGame?.();
    unsubscribePlayers?.();
    unsubscribeGame = null;
    unsubscribePlayers = null;
}

function joinSession(id) {
    clearSubscriptions();
    gameId = id;
    localPlayerState = {};
    allPlayersState = {};
    currentGameState = {};
    els.join_screen.classList.add('hidden');
    els.game_area.classList.remove('hidden');
    els.host_controls.classList.toggle('hidden', !isHost);
    els.all_players_area.classList.toggle('hidden', !isHost);
    els.player_area.classList.toggle('hidden', isHost);
    if (isHost) els.game_id_display.textContent = gameId;

    unsubscribeGame = onSnapshot(gameRef(), (snapshot) => {
        if (!snapshot.exists()) {
            setGameMessage('This game no longer exists.');
            return;
        }
        handleGame(snapshot.data());
    }, (error) => setGameMessage(readableError(error, 'Lost the game connection. Refresh to reconnect.')));

    if (isHost) {
        unsubscribePlayers = onSnapshot(playersRef(), (snapshot) => {
            const players = {};
            snapshot.forEach((playerSnapshot) => {
                players[playerSnapshot.id] = playerSnapshot.data();
            });
            handlePlayers(players);
        }, (error) => setGameMessage(readableError(error, 'Could not load the student list.')));
    } else {
        unsubscribePlayers = onSnapshot(playerRef(), (snapshot) => {
            if (!snapshot.exists()) {
                els.player_area.classList.add('hidden');
                setGameMessage('You were removed from the game. Refresh the page to join another game.');
                return;
            }
            localPlayerState = snapshot.data();
            renderLocalPlayer();
            updateControls();
        }, (error) => setGameMessage(readableError(error, 'Could not load your hand.')));
    }
}

function handleGame(game) {
    currentGameState = game;
    renderDealerHand(game);
    updateControls();
    if (isHost) evaluateHostAutomation();
}

function handlePlayers(players) {
    allPlayersState = players;
    renderHostGrid(players);
    updateControls();

    if (isHost) evaluateHostAutomation();
}

function evaluateHostAutomation() {
    if (!isHost) return;
    const playerList = Object.values(allPlayersState);

    if (currentGameState.state === 'betting') {
        const hasBet = playerList.some((player) => player.status === 'betPlaced' && player.bet > 0);
        const everyoneReady = playerList.length > 0 && playerList.every(
            (player) => player.status === 'betPlaced' || (player.status === 'waiting' && player.bankroll === 0),
        );
        if (hasBet && everyoneReady) scheduleAutoDeal();
        else clearTimeout(autoDealTimer);
    } else clearTimeout(autoDealTimer);

    if (currentGameState.state === 'playing') {
        if (playerList.some((player) => player.actionRequest)) scheduleActionBatch();
        const activePlayers = playerList.filter((player) => player.status === 'playing');
        if (activePlayers.length === 0) finishRound();
    }
}

function renderDealerHand(game) {
    els.dealer_cards.replaceChildren();
    const cards = game.dealerCards ?? [];
    cards.forEach((card) => els.dealer_cards.append(createCardElement(card)));

    const hiddenCardCount = game.reveal ? 0 : Math.max(0, (game.dealerCardCount ?? 0) - cards.length);
    for (let index = 0; index < hiddenCardCount; index += 1) {
        const cardBack = document.createElement('div');
        cardBack.className = 'card card-back';
        cardBack.setAttribute('aria-label', 'Hidden card');
        els.dealer_cards.append(cardBack);
    }
    els.dealer_score.textContent = game.reveal && game.dealerScore !== null ? game.dealerScore : '?';
}

function createCardElement(card) {
    const element = document.createElement('div');
    const isRed = card.suit === '♥' || card.suit === '♦';
    element.className = `card ${isRed ? 'red' : 'black'}`;
    element.setAttribute('aria-label', `${card.rank} of ${card.suit}`);

    const top = document.createElement('div');
    top.className = 'corner top';
    const center = document.createElement('div');
    center.className = 'suit-center';
    const bottom = document.createElement('div');
    bottom.className = 'corner bottom';

    for (const corner of [top, bottom]) {
        const rank = document.createElement('span');
        rank.textContent = card.rank;
        const suit = document.createElement('span');
        suit.textContent = card.suit;
        corner.append(rank, suit);
    }
    center.textContent = card.suit;
    element.append(top, center, bottom);
    return element;
}

function renderLocalPlayer() {
    const player = localPlayerState;
    if (!player.name) return;

    els.local_player_name.textContent = `${player.name} (${groupLabel(player.group)})`;
    els.player_bankroll.textContent = player.bankroll;
    els.player_bet.textContent = player.bet;
    els.player_score.textContent = calcScore(player.hand);
    els.player_cards.replaceChildren(...player.hand.map(createCardElement));
}

function renderHostGrid(players) {
    els.players_grid.replaceChildren();
    const entries = Object.entries(players).sort(([, left], [, right]) => left.name.localeCompare(right.name));
    els.player_count.textContent = entries.length;

    for (const [playerId, player] of entries) {
        const card = document.createElement('article');
        card.className = 'student-card';

        const name = document.createElement('p');
        name.className = 'student-name';
        name.textContent = player.name;

        const badge = document.createElement('span');
        badge.className = `group-badge group-${player.group.toLowerCase()}`;
        badge.textContent = groupLabel(player.group);

        const bankroll = document.createElement('p');
        bankroll.textContent = `Bank: $${player.bankroll}`;

        const status = document.createElement('p');
        status.className = 'muted';
        status.textContent = playerStatusLabel(player);

        const kickButton = document.createElement('button');
        kickButton.className = 'button kick-button';
        kickButton.type = 'button';
        kickButton.textContent = '×';
        kickButton.title = `Remove ${player.name}`;
        kickButton.setAttribute('aria-label', `Remove ${player.name}`);
        kickButton.addEventListener('click', () => kickPlayer(playerId, player.name));

        card.append(name, badge, bankroll, status, kickButton);
        els.players_grid.append(card);
    }
}

function playerStatusLabel(player) {
    if (player.actionRequest) return `Waiting: ${player.actionRequest.type}`;
    const labels = {
        waiting: 'Waiting',
        betPlaced: `Bet $${player.bet}`,
        playing: `Playing · ${calcScore(player.hand)}`,
        stood: `Stood · ${calcScore(player.hand)}`,
        busted: `Bust · ${calcScore(player.hand)}`,
    };
    return labels[player.status] ?? player.status;
}

function updateControls() {
    const game = currentGameState;
    if (!game.state) return;

    if (isHost) {
        const players = Object.values(allPlayersState);
        const canStart = ['waiting', 'finished'].includes(game.state) && players.length > 0;
        els.deal_hand_btn.disabled = !canStart;
        els.deal_hand_btn.textContent = game.state === 'finished' ? 'Start next round' : 'Start betting';
        const hasBet = players.some((player) => player.status === 'betPlaced' && player.bet > 0);
        const someoneWaiting = players.some((player) => player.status === 'waiting' && player.bankroll > 0);
        els.force_deal_btn.classList.toggle('hidden', game.state !== 'betting' || !hasBet || !someoneWaiting);
        els.host_status.textContent = hostStatusText(game, players);
        return;
    }

    const player = localPlayerState;
    if (!player.name) return;
    els.show_odds_btn.classList.toggle('hidden', !canUseStrategyHint(player.group));
    els.betting_controls.classList.add('hidden');
    els.action_controls.classList.add('hidden');

    if (game.state === 'betting' && player.status === 'waiting') {
        if (player.bankroll <= 0) {
            els.player_status.textContent = "You're out of chips for this game.";
            return;
        }
        const maximum = Math.min(200, player.bankroll);
        els.bet_amount.max = maximum;
        if (Number(els.bet_amount.value) > maximum) els.bet_amount.value = maximum;
        els.bet_amount_value.textContent = els.bet_amount.value;
        els.player_status.textContent = 'Place your bet.';
        els.place_bet_btn.disabled = false;
        els.betting_controls.classList.remove('hidden');
        return;
    }

    if (game.state === 'betting' && player.status === 'betPlaced') {
        els.player_status.textContent = 'Bet placed — waiting for the deal.';
        return;
    }

    if (game.state === 'playing' && player.status === 'playing') {
        if (player.actionRequest) {
            els.player_status.textContent = 'Dealer is processing your action…';
            return;
        }
        els.player_status.textContent = player.result || 'Choose an action.';
        els.action_controls.classList.remove('hidden');
        els.hit_btn.disabled = false;
        els.stand_btn.disabled = false;
        const canDouble = player.hand.length === 2 && player.bankroll >= player.bet;
        els.double_down_btn.disabled = !canDouble;
        return;
    }

    if (game.state === 'finished') els.player_status.textContent = player.result || 'Round complete.';
    else if (player.status === 'busted') els.player_status.textContent = 'Bust!';
    else if (player.status === 'stood') els.player_status.textContent = 'Standing — waiting for the round to finish.';
    else els.player_status.textContent = 'Waiting for the teacher.';
}

function hostStatusText(game, players) {
    if (players.length === 0) return 'Waiting for students to join.';
    if (players.length > MAX_CLASS_SIZE) return `${players.length} students joined — recommended maximum is ${MAX_CLASS_SIZE}.`;
    if (game.state === 'betting') {
        const ready = players.filter((player) => player.status === 'betPlaced').length;
        return `${ready} of ${players.length} students have placed a bet.`;
    }
    if (game.state === 'playing') return 'Round in progress. Keep this teacher tab open.';
    if (game.state === 'finished') return 'Round complete. Review results or start the next round.';
    return `${players.length} student${players.length === 1 ? '' : 's'} joined.`;
}

async function startBetting() {
    setGameMessage();
    els.deal_hand_btn.disabled = true;
    try {
        const snapshot = await getDocs(playersRef());
        if (snapshot.empty) {
            setGameMessage('At least one student must join before betting starts.');
            return;
        }

        const batch = writeBatch(db);
        batch.update(gameRef(), {
            state: 'betting',
            dealerCards: [],
            dealerCardCount: 0,
            dealerScore: null,
            reveal: false,
            updatedAt: Date.now(),
        });
        batch.update(hostStateRef(), { dealerHand: [] });
        snapshot.forEach((playerSnapshot) => {
            batch.update(playerSnapshot.ref, {
                bet: 0,
                hand: [],
                status: 'waiting',
                actionRequest: null,
                result: '',
            });
        });
        await batch.commit();
    } catch (error) {
        setGameMessage(readableError(error, 'Could not start betting. Please retry.'));
    } finally {
        updateControls();
    }
}

async function placeBet() {
    const amount = Number.parseInt(els.bet_amount.value, 10);
    els.place_bet_btn.disabled = true;
    try {
        await updateDoc(playerRef(), {
            bet: amount,
            bankroll: localPlayerState.bankroll - amount,
            status: 'betPlaced',
        });
    } catch (error) {
        setGameMessage(readableError(error, 'Could not place your bet. Please retry.'));
        els.place_bet_btn.disabled = false;
    }
}

function scheduleAutoDeal() {
    clearTimeout(autoDealTimer);
    autoDealTimer = setTimeout(() => dealCards(false), 750);
}

async function dealCards(force = false) {
    if (isDealing) return;
    isDealing = true;
    clearTimeout(autoDealTimer);
    setGameMessage();

    try {
        const roster = await getDocs(playersRef());
        const refs = roster.docs.map((snapshot) => snapshot.ref);

        await runTransaction(db, async (transaction) => {
            const refsToRead = [gameRef(), hostStateRef(), ...refs];
            const [publicSnapshot, privateSnapshot, ...playerSnapshots] = await Promise.all(
                refsToRead.map((ref) => transaction.get(ref)),
            );
            if (!publicSnapshot.exists() || !privateSnapshot.exists()) throw new Error('Game state is missing');
            if (publicSnapshot.data().state !== 'betting') return;

            const readyPlayers = playerSnapshots.filter(
                (snapshot) => snapshot.exists() && snapshot.data().status === 'betPlaced' && snapshot.data().bet > 0,
            );
            const everyoneReady = playerSnapshots.every((snapshot) => {
                if (!snapshot.exists()) return true;
                const player = snapshot.data();
                return player.status === 'betPlaced' || (player.status === 'waiting' && player.bankroll === 0);
            });
            if (!force && !everyoneReady) throw new Error('NOT_ALL_READY');
            if (readyPlayers.length === 0) throw new Error('NO_BETS');

            let deck = [...privateSnapshot.data().deck];
            const cardsNeeded = (readyPlayers.length * 2) + 2;
            if (deck.length < cardsNeeded + 20) deck = shuffle(buildDeck());

            const hands = new Map(readyPlayers.map((snapshot) => [snapshot.id, []]));
            const dealerHand = [];
            for (const snapshot of readyPlayers) hands.get(snapshot.id).push(deck.pop());
            dealerHand.push(deck.pop());
            for (const snapshot of readyPlayers) hands.get(snapshot.id).push(deck.pop());
            dealerHand.push(deck.pop());

            for (const snapshot of readyPlayers) {
                const hand = hands.get(snapshot.id);
                transaction.update(snapshot.ref, {
                    hand,
                    status: isBlackjack(hand) ? 'stood' : 'playing',
                    actionRequest: null,
                    result: isBlackjack(hand) ? 'Blackjack — waiting for the dealer.' : '',
                });
            }
            transaction.update(hostStateRef(), { deck, dealerHand });
            transaction.update(gameRef(), {
                state: 'playing',
                dealerCards: [dealerHand[0]],
                dealerCardCount: dealerHand.length,
                dealerScore: null,
                reveal: false,
                updatedAt: Date.now(),
            });
        });
    } catch (error) {
        if (error?.message === 'NOT_ALL_READY') setGameMessage('Some students still need to place a bet.');
        else if (error?.message === 'NO_BETS') setGameMessage('No students have placed a bet yet.');
        else setGameMessage(readableError(error, 'Could not deal the cards. Please retry.'));
    } finally {
        isDealing = false;
    }
}

async function requestAction(type) {
    const buttons = [els.hit_btn, els.stand_btn, els.double_down_btn];
    buttons.forEach((button) => { button.disabled = true; });
    try {
        await updateDoc(playerRef(), {
            actionRequest: {
                type,
                id: crypto.randomUUID(),
            },
        });
    } catch (error) {
        setGameMessage(readableError(error, 'The action was not accepted. Please retry.'));
        buttons.forEach((button) => { button.disabled = false; });
    }
}

function scheduleActionBatch() {
    clearTimeout(actionBatchTimer);
    actionBatchTimer = setTimeout(processActionBatch, ACTION_DEBOUNCE_MS);
}

async function processActionBatch() {
    if (isProcessingActions) {
        actionProcessingQueued = true;
        return;
    }
    if (!isHost || currentGameState.state !== 'playing') return;
    isProcessingActions = true;
    actionProcessingQueued = false;

    try {
        const roster = await getDocs(playersRef());
        const refs = roster.docs.map((snapshot) => snapshot.ref);
        await runTransaction(db, async (transaction) => {
            const refsToRead = [gameRef(), hostStateRef(), ...refs];
            const [publicSnapshot, privateSnapshot, ...playerSnapshots] = await Promise.all(
                refsToRead.map((ref) => transaction.get(ref)),
            );
            if (!publicSnapshot.exists() || publicSnapshot.data().state !== 'playing') return;
            if (!privateSnapshot.exists()) throw new Error('Private game state is missing');

            let deck = [...privateSnapshot.data().deck];
            let deckChanged = false;
            let processedRequest = false;

            for (const snapshot of playerSnapshots) {
                if (!snapshot.exists()) continue;
                const player = snapshot.data();
                const request = player.actionRequest;
                if (!request) continue;
                processedRequest = true;

                if (player.status !== 'playing') {
                    transaction.update(snapshot.ref, { actionRequest: null });
                    continue;
                }

                if (request.type === 'stand') {
                    transaction.update(snapshot.ref, { status: 'stood', actionRequest: null, result: '' });
                    continue;
                }

                const canDouble = player.hand.length === 2 && player.bankroll >= player.bet;
                if (request.type === 'double' && !canDouble) {
                    transaction.update(snapshot.ref, { actionRequest: null, result: 'Double down is not available.' });
                    continue;
                }

                if (deck.length === 0) deck = shuffle(buildDeck());
                const hand = [...player.hand, deck.pop()];
                deckChanged = true;
                const score = calcScore(hand);

                if (request.type === 'double') {
                    transaction.update(snapshot.ref, {
                        hand,
                        bankroll: player.bankroll - player.bet,
                        bet: player.bet * 2,
                        status: score > 21 ? 'busted' : 'stood',
                        actionRequest: null,
                        result: '',
                    });
                } else {
                    transaction.update(snapshot.ref, {
                        hand,
                        status: score > 21 ? 'busted' : score === 21 ? 'stood' : 'playing',
                        actionRequest: null,
                        result: '',
                    });
                }
            }

            if (processedRequest && deckChanged) transaction.update(hostStateRef(), { deck });
        });
    } catch (error) {
        setGameMessage(readableError(error, 'A student action could not be processed. It is safe to retry.'));
    } finally {
        isProcessingActions = false;
        if (actionProcessingQueued) scheduleActionBatch();
        else evaluateHostAutomation();
    }
}

async function finishRound() {
    if (isFinishingRound || isProcessingActions) return;
    isFinishingRound = true;

    try {
        const roster = await getDocs(playersRef());
        const refs = roster.docs.map((snapshot) => snapshot.ref);
        await runTransaction(db, async (transaction) => {
            const refsToRead = [gameRef(), hostStateRef(), ...refs];
            const [publicSnapshot, privateSnapshot, ...playerSnapshots] = await Promise.all(
                refsToRead.map((ref) => transaction.get(ref)),
            );
            if (!publicSnapshot.exists() || publicSnapshot.data().state !== 'playing') return;
            if (playerSnapshots.some((snapshot) => snapshot.exists() && snapshot.data().status === 'playing')) return;

            let deck = [...privateSnapshot.data().deck];
            const dealerHand = [...privateSnapshot.data().dealerHand];
            let safetyCounter = 0;
            while (calcScore(dealerHand) < 17 && safetyCounter < 20) {
                if (deck.length === 0) deck = shuffle(buildDeck());
                dealerHand.push(deck.pop());
                safetyCounter += 1;
            }

            for (const snapshot of playerSnapshots) {
                if (!snapshot.exists()) continue;
                const player = snapshot.data();
                if (!['stood', 'busted'].includes(player.status) || player.bet <= 0) continue;
                const outcome = settleHand(player, dealerHand);
                transaction.update(snapshot.ref, {
                    bankroll: player.bankroll + outcome.credit,
                    actionRequest: null,
                    result: outcome.result,
                });
            }

            transaction.update(hostStateRef(), { deck, dealerHand });
            transaction.update(gameRef(), {
                state: 'finished',
                dealerCards: dealerHand,
                dealerCardCount: dealerHand.length,
                dealerScore: calcScore(dealerHand),
                reveal: true,
                updatedAt: Date.now(),
            });
        });
    } catch (error) {
        setGameMessage(readableError(error, 'Could not finish the round. Please retry.'));
    } finally {
        isFinishingRound = false;
    }
}

async function kickPlayer(playerId, playerName) {
    if (!window.confirm(`Remove ${playerName} from this game?`)) return;
    try {
        await deleteDoc(playerRef(playerId));
    } catch (error) {
        setGameMessage(readableError(error, `Could not remove ${playerName}.`));
    }
}

function showStrategyHint() {
    if (!canUseStrategyHint(localPlayerState.group)) return;
    const canDouble = localPlayerState.hand.length === 2 && localPlayerState.bankroll >= localPlayerState.bet;
    const action = getBestAction(localPlayerState.hand, currentGameState.dealerCards?.[0], canDouble);
    const target = action === 'double' ? els.double_down_btn : action === 'stand' ? els.stand_btn : els.hit_btn;
    target.classList.add('highlight-action');
    setTimeout(() => target.classList.remove('highlight-action'), 2200);
    els.player_status.textContent = `Strategy hint: ${action === 'double' ? 'double down' : action}.`;
}

function showSummary() {
    els.summary_content.replaceChildren();
    for (const summary of summarizeGroups(Object.values(allPlayersState))) {
        const row = document.createElement('div');
        row.className = `summary-row group-${summary.group.toLowerCase()}`;
        row.setAttribute('role', 'listitem');
        row.setAttribute(
            'aria-label',
            `${summary.label}: $${summary.average} average across ${summary.count} student${summary.count === 1 ? '' : 's'}`,
        );

        const header = document.createElement('div');
        header.className = 'summary-row-header';
        const label = document.createElement('span');
        label.className = 'summary-group-label';
        label.textContent = summary.label;
        const average = document.createElement('strong');
        average.className = 'summary-average';
        average.textContent = `$${summary.average.toLocaleString()} avg`;
        header.append(label, average);

        const bar = document.createElement('progress');
        bar.className = 'summary-bar';
        bar.max = 100;
        bar.value = summary.barPercent;
        bar.setAttribute('aria-hidden', 'true');

        const count = document.createElement('small');
        count.className = 'summary-count';
        count.textContent = `${summary.count} student${summary.count === 1 ? '' : 's'}`;

        row.append(header, bar, count);
        els.summary_content.append(row);
    }
    els.summary_modal.showModal();
}

async function copyJoinLink() {
    try {
        const joinUrl = new URL(window.location.href);
        joinUrl.search = '';
        joinUrl.hash = '';
        joinUrl.searchParams.set('game', gameId);
        await navigator.clipboard.writeText(joinUrl.toString());
        els.copy_code_btn.textContent = 'Copied!';
        setTimeout(() => { els.copy_code_btn.textContent = 'Copy join link'; }, 1400);
    } catch {
        setGameMessage(`Game code: ${gameId}`);
    }
}

els.create_game_btn.addEventListener('click', createGame);
els.join_game_btn.addEventListener('click', joinGame);
els.game_id_input.addEventListener('input', () => {
    els.game_id_input.value = normalizeGameId(els.game_id_input.value);
});
els.copy_code_btn.addEventListener('click', copyJoinLink);
els.deal_hand_btn.addEventListener('click', startBetting);
els.force_deal_btn.addEventListener('click', () => dealCards(true));
els.bet_amount.addEventListener('input', () => { els.bet_amount_value.textContent = els.bet_amount.value; });
els.place_bet_btn.addEventListener('click', placeBet);
els.hit_btn.addEventListener('click', () => requestAction('hit'));
els.stand_btn.addEventListener('click', () => requestAction('stand'));
els.double_down_btn.addEventListener('click', () => requestAction('double'));
els.show_odds_btn.addEventListener('click', showStrategyHint);
els.show_summary_btn.addEventListener('click', showSummary);
els.close_summary_btn.addEventListener('click', () => els.summary_modal.close());
window.addEventListener('beforeunload', clearSubscriptions);

initialize();
