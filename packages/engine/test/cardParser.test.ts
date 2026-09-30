import { describe, it, expect } from 'vitest';
import { parseScryfallCard, isStandardLegal, classifyCategory } from '../src/cardParser.js';

function raw(over: Partial<Parameters<typeof parseScryfallCard>[0]> = {}) {
  return {
    id: 'card-1',
    name: 'Test Card',
    type_line: 'Creature — Test',
    colors: ['W'],
    legalities: { standard: 'legal' },
    ...over,
  };
}

function parse(over: Parameters<typeof parseScryfallCard>[0]) {
  return parseScryfallCard(over);
}

describe('parseScryfallCard 基础分类', () => {
  it('无能力的普通生物也支持（空 oracle 文本）', () => {
    const r = parse(
      raw({ type_line: 'Creature — Bear', oracle_text: undefined, power: '2', toughness: '2' }),
    );
    expect(r.supported).toBe(true);
    expect(r.card?.category).toBe('creature');
    expect(r.card?.abilities).toEqual([]);
    expect(r.card?.power).toBe(2);
    expect(r.card?.toughness).toBe(2);
  });

  it('分类：地 / 生物 / 灵气 / 法术 / 瞬间', () => {
    expect(classifyCategory('Basic Land — Plains')).toBe('land');
    expect(classifyCategory('Creature — Human Soldier')).toBe('creature');
    expect(classifyCategory('Enchantment — Aura')).toBe('aura');
    expect(classifyCategory('Sorcery')).toBe('sorcery');
    expect(classifyCategory('Instant')).toBe('instant');
    expect(classifyCategory('Artifact')).toBeNull();
    expect(classifyCategory('Planeswalker — Jace')).toBeNull();
  });

  it('标准赛合法性判定', () => {
    expect(isStandardLegal(raw())).toBe(true);
    expect(isStandardLegal(raw({ legalities: { standard: 'not_legal' } }))).toBe(false);
  });
});

describe('关键字能力', () => {
  it('单行多个关键字 → 多个 KEYWORD 能力', () => {
    const r = parse(
      raw({ oracle_text: 'Flying, Vigilance', power: '4', toughness: '4' }),
    );
    expect(r.supported).toBe(true);
    expect(r.card?.abilities).toEqual([
      { type: 'KEYWORD', keyword: 'FLYING' },
      { type: 'KEYWORD', keyword: 'VIGILANCE' },
    ]);
  });
});

describe('产出法术力的启动式异能', () => {
  it('精灵产绿：{T}: Add {G}.  → ACTIVATED TAP ADD_MANA', () => {
    const r = parse(
      raw({
        oracle_text: 'Flying\n({T}: Add {G}.)\n{T}: Add {G}.',
        power: '1', toughness: '1',
      }),
    );
    expect(r.supported).toBe(true);
    expect(r.card?.abilities).toContainEqual({
      type: 'ACTIVATED', cost: { type: 'TAP' }, effect: { kind: 'ADD_MANA', color: 'G', amount: 1 },
    });
  });

  it('付费启动式：{1}{G}: +1/+1 until end of turn', () => {
    const r = parse(
      raw({ oracle_text: '{1}{G}: This creature gets +1/+1 until end of turn.', power: '1', toughness: '1' }),
    );
    expect(r.supported).toBe(true);
    expect(r.card?.abilities[0]).toEqual({
      type: 'ACTIVATED',
      cost: { type: 'MANA', cost: '{1}{G}' },
      effect: { kind: 'POWER_TOUGHNESS', powerMod: 1, toughnessMod: 1, duration: 'ENDOF_TURN' },
    });
  });
});

describe('触发式异能', () => {
  it('进场：When this creature enters the battlefield, you gain 2 life.', () => {
    const r = parse(
      raw({ oracle_text: 'When this creature enters the battlefield, you gain 2 life.', power: '1', toughness: '1' }),
    );
    expect(r.supported).toBe(true);
    expect(r.card?.abilities[0]).toEqual({
      type: 'TRIGGERED', trigger: { kind: 'ETB' }, effect: { kind: 'LIFEGAIN', amount: 2 },
    });
  });

  it('维持：At the beginning of your upkeep, you gain 1 life.', () => {
    const r = parse(
      raw({ oracle_text: 'At the beginning of your upkeep, you gain 1 life.', power: '1', toughness: '1' }),
    );
    expect(r.supported).toBe(true);
    expect(r.card?.abilities[0].type).toBe('TRIGGERED');
    expect(r.card?.abilities[0].trigger).toEqual({ kind: 'UPKEEP' });
    expect(r.card?.abilities[0].effect.kind).toBe('LIFEGAIN');
  });
});

describe('法术 / 瞬间', () => {
  it('瞬间：Destroy target creature. → SPELL DESTROY', () => {
    const r = parse(raw({ type_line: 'Instant', mana_cost: '{1}{W}', oracle_text: 'Destroy target creature.' }));
    expect(r.supported).toBe(true);
    expect(r.card?.category).toBe('instant');
    expect(r.card?.abilities[0]).toEqual({
      type: 'SPELL', effect: { kind: 'DESTROY', what: 'creature' },
    });
  });

  it('法术：Deal 3 damage to any target. → SPELL DAMAGE', () => {
    const r = parse(raw({ type_line: 'Sorcery', mana_cost: '{2}{R}', oracle_text: 'Deal 3 damage to any target.' }));
    expect(r.supported).toBe(true);
    expect(r.card?.abilities[0].effect).toEqual({ kind: 'DAMAGE', amount: 3 });
  });
});

describe('灵气', () => {
  it('基础灵气：Enchant creature', () => {
    const r = parse(raw({ type_line: 'Enchantment — Aura', mana_cost: '{1}{W}', oracle_text: 'Enchant creature.' }));
    expect(r.supported).toBe(true);
    expect(r.card?.category).toBe('aura');
    expect(r.card?.abilities[0].effect.kind).toBe('AURA');
  });
});

describe('基本地', () => {
  // Scryfall 上基本地的产费写作提醒文字（整行括号），按副类别补齐
  const basics: [string, string, string][] = [
    ['Plains', 'W', '({T}: Add {W}.)'],
    ['Island', 'U', '({T}: Add {U}.)'],
    ['Swamp', 'B', '({T}: Add {B}.)'],
    ['Mountain', 'R', '({T}: Add {R}.)'],
    ['Forest', 'G', '({T}: Add {G}.)'],
  ];

  it.each(basics)('%s 应具备横置产 %s 的异能', (name, color, oracle) => {
    const r = parse(raw({ name, type_line: `Basic Land — ${name}`, colors: [], oracle_text: oracle }));
    expect(r.supported).toBe(true);
    expect(r.card?.abilities).toEqual([
      { type: 'ACTIVATED', cost: { type: 'TAP' }, effect: { kind: 'ADD_MANA', color, amount: 1 } },
    ]);
  });

  it('雪境基本地同样按副类别补齐', () => {
    const r = parse(raw({ name: 'Snow-Covered Forest', type_line: 'Basic Snow Land — Forest', colors: [], oracle_text: '({T}: Add {G}.)' }));
    expect(r.card?.abilities[0].effect).toEqual({ kind: 'ADD_MANA', color: 'G', amount: 1 });
  });

  it('已解析出产费异能的地不重复补齐', () => {
    const r = parse(raw({ name: 'Plains', type_line: 'Basic Land — Plains', colors: [], oracle_text: '{T}: Add {W}.' }));
    expect(r.card?.abilities.length).toBe(1);
  });
});

describe('不支持的卡被过滤', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['鹏洛客', { type_line: 'Planeswalker — Jace 2' }, '鹏洛客'],
    ['双面/冒险牌', { name: 'A // B', type_line: 'Creature', oracle_text: 'Flying', mana_cost: '{1} // {2}' }, '双面/冒险'],
    ['保护', { oracle_text: 'Protection from red.' }, '硬机制'],
    ['辟邪', { oracle_text: 'Hexproof' }, '硬机制'],
    ['不灭', { oracle_text: 'Indestructible' }, '硬机制'],
    ['费用含 X', { type_line: 'Sorcery', mana_cost: '{X}{R}', oracle_text: 'Deal X damage to any target.' }, '费用含 {X}'],
    ['无法解析的能力行', { oracle_text: 'Whenever this creature attacks, draw a card.', power: '1', toughness: '1' }, '无法解析'],
    ['非数值 P/T', { oracle_text: 'Flying', power: '*', toughness: '3' }, 'P/T 非数值'],
    ['不支持的 layout', { type_line: 'Creature — Wolf', layout: 'transform', oracle_text: 'Flying' }, 'layout'],
  ];

  it.each(cases)('%s → supported=false（%s）', (_label, over, reasonPart) => {
    const r = parse(raw(over));
    expect(r.supported).toBe(false);
    expect(r.card).toBeNull();
    expect(r.reason).toContain(reasonPart);
  });
});