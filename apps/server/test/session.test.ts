import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseScryfallCard, ScryfallCardRaw } from '@mtg/engine';
import { openDatabase, closeDatabase } from '../src/data/db.js';
import { insertCard } from '../src/data/store.js';
import { GameSession } from '../src/session/session.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Card } from '@mtg/engine';

let db: DatabaseSync;

function makeCard(raw: Partial<ScryfallCardRaw>): Card {
  const r = parseScryfallCard({
    id: raw.id ?? 'c1',
    name: raw.name ?? 'Sample',
    type_line: raw.type_line ?? 'Creature — Human',
    colors: ['W'],
    legalities: { standard: 'legal' },
    ...raw,
  });
  if (!r.supported || !r.card) throw new Error(`样本应受支持: ${r.reason}`);
  return r.card;
}

beforeAll(() => {
  db = openDatabase(':memory:');
});

afterAll(() => {
  closeDatabase(db);
});

/** 取某玩家的可观察状态。 */
function playerOf(session: GameSession, id: string) {
  return session.view.players.find((p) => p.id === id)!;
}

describe('M9 对局会话', () => {
  it('用真实卡池构建牌组并完成双方起手', () => {
    insertCard(db, makeCard({ id: 'l1', name: 'Plains', type_line: 'Basic Land — Plains', oracle_text: '{T}: Add {W}.' }), {
      legalStandard: true,
    });
    insertCard(
      db,
      makeCard({
        id: 'c1',
        name: 'Test Bear',
        mana_cost: '{1}',
        type_line: 'Creature — Bear',
        oracle_text: 'Flying',
        power: '2',
        toughness: '2',
      }),
      { legalStandard: true },
    );
    insertCard(db, makeCard({ id: 's1', mana_cost: '{1}', type_line: 'Sorcery', oracle_text: 'Deal 2 damage' }), {
      legalStandard: true,
    });

    const session = new GameSession({ db });
    expect(playerOf(session, 'p1').hand.length).toBe(7);
    expect(playerOf(session, 'p2').hand.length).toBe(7);
    expect(playerOf(session, 'p1').library.length).toBe(53); // 60 - 7

    const snap = session.takeSnapshot();
    expect(snap.events[0].by).toBe('system');
    expect(snap.events[0].message).toContain('60');
  });

  it('卡池为空时回退到引擎内置牌组，会话仍可用', () => {
    const emptyDb = openDatabase(':memory:');
    const session = new GameSession({ db: emptyDb });
    expect(playerOf(session, 'p1').hand.length).toBe(7);
    expect(playerOf(session, 'p2').library.length).toBe(53);
    closeDatabase(emptyDb);
  });

  it('非法动作返回错误且不改变状态', () => {
    const session = new GameSession({ db });
    // 先让过进入主阶段（此时人类持有优先权）
    for (let i = 0; i < 10; i++) {
      const r = session.playAction({ type: 'PASS' });
      if (!r.ok || session.view.step === 'FIRST_MAIN') break;
    }
    const handBefore = playerOf(session, 'p1').hand.length;
    const result = session.playAction({ type: 'CAST', handIndex: 999 });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('下标越界');
    expect(playerOf(session, 'p1').hand.length).toBe(handBefore);
  });

  it('人类动作后 AI 自动响应（会自行下地）', () => {
    const session = new GameSession({ db });
    let aiLands = 0;
    for (let i = 0; i < 60 && !session.engine.isOver; i++) {
      const r = session.playAction({ type: 'PASS' });
      if (!r.ok) break;
      aiLands = playerOf(session, 'p2').battlefield.filter((p) => p.card.category === 'land').length;
      if (aiLands > 0) break;
    }
    expect(aiLands).toBeGreaterThan(0);
  });

  it('事件流是增量的：取快照后事件清空', () => {
    const session = new GameSession({ db });
    expect(session.takeSnapshot().events.length).toBeGreaterThan(0); // 开局事件
    expect(session.takeSnapshot().events.length).toBe(0); // 已取走
  });

  it('人类持续让过可打完整局，AI 获胜', () => {
    const session = new GameSession({ db });
    for (let i = 0; i < 600 && !session.engine.isOver; i++) {
      const r = session.playAction({ type: 'PASS' });
      if (!r.ok) break; // 对局结束或轮不到人类
    }
    expect(session.engine.isOver).toBe(true);
    expect(session.view.winnerId).toBe('p2'); // 人类从不出牌，必然落败
  });
});