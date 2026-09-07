import { describe, expect, it } from 'vitest';
import { ask, CLOSED_TAIL, markFor, questionFingerprint, recordTickets } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { Actor, Question } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: '0.5', session: 'rev:mason' };

const question: Question = {
  situation: 'A venue is holding the date until Friday.',
  question: 'Pay the deposit?',
  options: [
    { label: 'pay', consequence: 'the date is locked' },
    { label: 'wait', consequence: 'the date may go' },
  ],
  recommendation: 'pay',
};

function create(s: Store) {
  return s.createTicket(builder, {
    title: 'Build the importer',
    body: 'Goal: import CSVs.',
    workstream: 'estate-ui',
    type: 'build',
  });
}

describe('dashboard presentation', () => {
  it('gives known crew and human actors marks, but leaves unknown agents bare', () => {
    expect(markFor('mason', 'agent')).toBe('mason');
    expect(markFor('Arthur Coulston', 'human')).toBe('person');
    expect(markFor('newcomer-loop', 'agent')).toBeNull();
  });

  it('letters a decision once and fingerprints everything the operator sees', () => {
    expect(ask(question)).toEqual({
      fingerprint: questionFingerprint(question),
      situation: question.situation,
      question: question.question,
      recommendation: question.recommendation,
      options: [
        { letter: 'a', label: 'pay', consequence: 'the date is locked' },
        { letter: 'b', label: 'wait', consequence: 'the date may go' },
      ],
    });
    const base = questionFingerprint(question);
    expect(questionFingerprint({ ...question })).toBe(base);
    expect(questionFingerprint({ ...question, recommendation: 'wait' })).not.toBe(base);
    expect(questionFingerprint({ ...question, question: 'Pay tomorrow?' })).not.toBe(base);
    expect(questionFingerprint({ ...question, situation: 'The hold ends tonight.' })).not.toBe(base);
    expect(questionFingerprint({ ...question, if_unanswered: 'the date goes' })).not.toBe(base);
    expect(questionFingerprint({ ...question, options: [question.options![1]!, question.options![0]!] })).not.toBe(base);
  });

  it('omits options when the recommendation stands alone', () => {
    expect(ask({ ...question, options: undefined })).not.toHaveProperty('options');
  });

  it('keeps every live ticket and only the newest closed tail by default', () => {
    const s = new Store(':memory:');
    const live = create(s);
    const closed = Array.from({ length: CLOSED_TAIL + 3 }, () => {
      const t = create(s);
      s.updateTicket(builder, { ticket_id: t.id, note: 'done', status: 'done' });
      return t.id;
    });
    const all = s.listTickets({ limit: 1000 });
    expect(recordTickets(all).map((t) => t.id)).toEqual([live.id, ...[...closed].reverse().slice(0, CLOSED_TAIL)]);
    expect(recordTickets(all, true).map((t) => t.id)).toEqual([live.id, ...[...closed].reverse()]);
  });
});
