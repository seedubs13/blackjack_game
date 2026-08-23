export const SUITS = Object.freeze(['♠', '♣', '♥', '♦']);
export const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
export const GROUP_LABELS = Object.freeze({
    A: 'Experienced',
    B: 'Understand the Game',
    C: "No Clue What I'm Doing",
});

export function groupLabel(group) {
    return GROUP_LABELS[group] ?? group;
}

export function canUseStrategyHint(group) {
    return group === 'C';
}

export function summarizeGroups(players = []) {
    const summaries = Object.keys(GROUP_LABELS).map((group) => ({
        group,
        label: groupLabel(group),
        total: 0,
        count: 0,
    }));
    const byGroup = Object.fromEntries(summaries.map((summary) => [summary.group, summary]));

    for (const player of players) {
        const summary = byGroup[player.group];
        if (!summary || !Number.isFinite(player.bankroll)) continue;
        summary.total += player.bankroll;
        summary.count += 1;
    }

    const averages = summaries.map((summary) => (
        summary.count === 0 ? 0 : Math.round(summary.total / summary.count)
    ));
    const highestAverage = Math.max(0, ...averages);

    return summaries.map((summary, index) => ({
        group: summary.group,
        label: summary.label,
        count: summary.count,
        average: averages[index],
        barPercent: highestAverage === 0 ? 0 : Math.round((averages[index] / highestAverage) * 100),
    }));
}

export function buildDeck(deckCount = 6) {
    const deck = [];
    for (let copy = 0; copy < deckCount; copy += 1) {
        for (const suit of SUITS) {
            for (const rank of RANKS) deck.push({ rank, suit });
        }
    }
    return deck;
}

function secureRandomInt(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError('maxExclusive must be a positive integer');
    }

    const range = 0x100000000;
    const limit = range - (range % maxExclusive);
    const values = new Uint32Array(1);
    do {
        globalThis.crypto.getRandomValues(values);
    } while (values[0] >= limit);
    return values[0] % maxExclusive;
}

export function shuffle(deck, randomInt = secureRandomInt) {
    const shuffled = [...deck];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const otherIndex = randomInt(index + 1);
        [shuffled[index], shuffled[otherIndex]] = [shuffled[otherIndex], shuffled[index]];
    }
    return shuffled;
}

export function calcScore(hand = []) {
    let score = 0;
    let aces = 0;

    for (const card of hand) {
        if (['J', 'Q', 'K'].includes(card.rank)) score += 10;
        else if (card.rank === 'A') {
            score += 11;
            aces += 1;
        } else score += Number.parseInt(card.rank, 10);
    }

    while (score > 21 && aces > 0) {
        score -= 10;
        aces -= 1;
    }
    return score;
}

export function isBlackjack(hand = []) {
    return hand.length === 2 && calcScore(hand) === 21;
}

export function settleHand(player, dealerHand) {
    const playerScore = calcScore(player.hand);
    const dealerScore = calcScore(dealerHand);
    const playerBlackjack = isBlackjack(player.hand);
    const dealerBlackjack = isBlackjack(dealerHand);

    if (player.status === 'busted' || playerScore > 21) {
        return { credit: 0, result: 'Lost — bust' };
    }
    if (playerBlackjack && dealerBlackjack) {
        return { credit: player.bet, result: 'Push — both blackjack' };
    }
    if (playerBlackjack) {
        return { credit: player.bet * 2.5, result: 'Blackjack!' };
    }
    if (dealerBlackjack) {
        return { credit: 0, result: 'Lost — dealer blackjack' };
    }
    if (dealerScore > 21) {
        return { credit: player.bet * 2, result: 'Won — dealer bust' };
    }
    if (playerScore > dealerScore) {
        return { credit: player.bet * 2, result: 'Won' };
    }
    if (playerScore === dealerScore) {
        return { credit: player.bet, result: 'Push' };
    }
    return { credit: 0, result: 'Lost' };
}

function cardValue(card) {
    if (!card) return 0;
    if (['J', 'Q', 'K'].includes(card.rank)) return 10;
    if (card.rank === 'A') return 11;
    return Number.parseInt(card.rank, 10);
}

export function getBestAction(hand, dealerUpCard, canDouble = false) {
    const score = calcScore(hand);
    const dealer = cardValue(dealerUpCard);
    const hardScore = hand.reduce((total, card) => total + (card.rank === 'A' ? 1 : cardValue(card)), 0);
    const isSoft = score !== hardScore;

    if (isSoft) {
        if (score >= 19) return 'stand';
        if (score === 18) {
            if (canDouble && dealer >= 3 && dealer <= 6) return 'double';
            if (dealer === 2 || dealer === 7 || dealer === 8) return 'stand';
            return 'hit';
        }
        if (canDouble && score >= 16 && score <= 17 && dealer >= 3 && dealer <= 6) return 'double';
        if (canDouble && score >= 13 && score <= 15 && dealer >= 5 && dealer <= 6) return 'double';
        return 'hit';
    }

    if (score >= 17) return 'stand';
    if (score >= 13) return dealer >= 2 && dealer <= 6 ? 'stand' : 'hit';
    if (score === 12) return dealer >= 4 && dealer <= 6 ? 'stand' : 'hit';
    if (score === 11) return canDouble && dealer <= 10 ? 'double' : 'hit';
    if (score === 10) return canDouble && dealer >= 2 && dealer <= 9 ? 'double' : 'hit';
    if (score === 9) return canDouble && dealer >= 3 && dealer <= 6 ? 'double' : 'hit';
    return 'hit';
}
