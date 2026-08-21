import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDeck,
    calcScore,
    getBestAction,
    isBlackjack,
    settleHand,
    shuffle,
} from '../public/game-logic.js';

const card = (rank, suit = '♠') => ({ rank, suit });

test('a six-deck shoe contains 312 cards and supports a 40-player deal', () => {
    const deck = buildDeck();
    assert.equal(deck.length, 312);
    assert.ok(deck.length >= (40 * 2) + 2);
});

test('shuffle returns a new array without losing cards', () => {
    const deck = buildDeck(1);
    const shuffled = shuffle(deck, () => 0);
    assert.equal(shuffled.length, 52);
    assert.notEqual(shuffled, deck);
    assert.deepEqual([...shuffled].sort((a, b) => `${a.rank}${a.suit}`.localeCompare(`${b.rank}${b.suit}`)),
        [...deck].sort((a, b) => `${a.rank}${a.suit}`.localeCompare(`${b.rank}${b.suit}`)));
});

test('aces are reduced from eleven to one as needed', () => {
    assert.equal(calcScore([card('A'), card('A'), card('9')]), 21);
    assert.equal(calcScore([card('A'), card('9'), card('9')]), 19);
});

test('blackjack requires exactly two cards', () => {
    assert.equal(isBlackjack([card('A'), card('K')]), true);
    assert.equal(isBlackjack([card('7'), card('7'), card('7')]), false);
});

test('a busted double-down hand never wins when the dealer also busts', () => {
    const outcome = settleHand({
        hand: [card('10'), card('6'), card('K')],
        status: 'busted',
        bet: 100,
    }, [card('10'), card('6'), card('Q')]);
    assert.deepEqual(outcome, { credit: 0, result: 'Lost — bust' });
});

test('blackjack pays the returned stake plus three-to-two winnings', () => {
    const outcome = settleHand({
        hand: [card('A'), card('K')],
        status: 'stood',
        bet: 50,
    }, [card('10'), card('9')]);
    assert.deepEqual(outcome, { credit: 125, result: 'Blackjack!' });
});

test('push returns the original bet', () => {
    const outcome = settleHand({
        hand: [card('10'), card('8')],
        status: 'stood',
        bet: 50,
    }, [card('9'), card('9')]);
    assert.deepEqual(outcome, { credit: 50, result: 'Push' });
});

test('strategy hint recommends common hard-total actions', () => {
    assert.equal(getBestAction([card('10'), card('6')], card('10'), false), 'hit');
    assert.equal(getBestAction([card('10'), card('7')], card('10'), false), 'stand');
    assert.equal(getBestAction([card('5'), card('6')], card('6'), true), 'double');
});
