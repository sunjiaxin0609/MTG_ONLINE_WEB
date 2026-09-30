/**
 * cardParser —— 能力解析器（M3 核心数据层）。
 *
 * 把 Scryfall 的单张卡 JSON 文本，映射为引擎可执行的结构化 `Card`（能力指令模型）。
 * 规则：Oracle 文本按行拆解，每行都须被识别成一种结构化能力；
 * 只要有一行无法识别，或者卡属于「硬机制」（鹏洛客/Turnover/保护/辟邪/不灭/含 X 费用等），
 * 该卡就被标记为 `supported=false`，在卡池构建阶段过滤掉。
 */

import {
  Card,
  CardAbility,
  CardCategory,
  AbilityEffect,
  ActivatedCost,
  TriggerInfo,
  KEYWORDS,
  KeywordId,
  ManaSymbol,
} from './types.js';

/** 抓取阶段直接从 Scryfall JSON 传入的必需字段（宽松类型，只取用到的部分）。 */
export interface ScryfallCardRaw {
  id: string;
  name?: string;
  mana_cost?: string | null;
  type_line?: string;
  colors?: string[] | null;
  power?: string | null;
  toughness?: string | null;
  oracle_text?: string | null;
  layout?: string;
  image_uris?: { normal?: string; large?: string } | null;
  legalities?: { standard?: string };
}

/** 解析结果：card 存在当且仅当 supported 为 true。 */
export interface ParseCardResult {
  card: Card | null;
  supported: boolean;
  /** supported=false 时的原因。 */
  reason?: string;
}

const KEYWORD_WORD: Record<string, KeywordId> = {
  Flying: 'FLYING',
  Trample: 'TRAMPLE',
  'Double strike': 'DOUBLE_STRIKE',
  Vigilance: 'VIGILANCE',
  'First strike': 'FIRST_STRIKE',
  Intimidate: 'INTIMIDATE',
  Reach: 'REACH',
  Haste: 'HASTE',
  Defender: 'DEFENDER',
  Deathtouch: 'DEATHTOUCH',
};

const REMINDER_RE = /^\(.*\)$/;

/**
 * 基本地副类别 → 产费颜色。
 * Scryfall 上基本地的 Oracle 文本写作提醒文字形式（如 "({T}: Add {G}.)"），
 * 会被提醒文字规则整行跳过；按万智牌规则，基本地本身即具有对应产费异能，故按副类别补齐。
 */
const BASIC_LAND_MANA: Record<string, ManaSymbol> = {
  Plains: 'W',
  Island: 'U',
  Swamp: 'B',
  Mountain: 'R',
  Forest: 'G',
  Wastes: 'C',
};

/** 从类型行取出基本地副类别（如 "Basic Land — Forest" → "Forest"）。 */
function basicLandSubtype(typeLine: string): string | null {
  const m = typeLine.match(/\bBasic\b[^—]*—\s*(.+)$/);
  if (!m) return null;
  const subtype = m[1].trim();
  return subtype in BASIC_LAND_MANA ? subtype : null;
}

/** 判定卡是否在标准赛合法（legalities.standard === 'legal'）。 */
export function isStandardLegal(raw: ScryfallCardRaw): boolean {
  return raw.legalities?.standard === 'legal';
}

/** 检测会被排除的「硬机制」。（非目标列表：保护/辟邪/不灭/隐藏/Turnover/瞬面等） */
function hasHardMechanics(raw: ScryfallCardRaw, oracle: string): string | null {
  const tl = raw.type_line ?? '';
  // 双面/冒险/混合牌：名字带 " // "（如 "A // B"）无法按其单面建模
  if ((raw.name ?? '').includes(' // ') || (raw.mana_cost ?? '').includes(' // ')) {
    return '双面/冒险牌';
  }
  if (/\bPlaneswalker\b/i.test(tl)) return '鹏洛客';
  const layout = raw.layout ?? '';
  if (['transform', 'modal_dfc', 'double_faced', 'adventure', 'token', 'melds', 'reversible_card'].includes(layout)) {
    return `不支持的 layout: ${layout}`;
  }
  for (const word of ['protection from', 'hexproof', 'indestructible', 'shroud']) {
    if (oracle.toLowerCase().includes(word)) return `硬机制: ${word}`;
  }
  // Turnover 类文本
  if (oracle.includes('Transform')) return 'Transform 文本';
  return null;
}

/** 依据 type_line 判定大类别；不在支持范围内的（器物/非灵气结界等）返回 null。 */
export function classifyCategory(typeLine: string): CardCategory | null {
  if (/\bLand\b/i.test(typeLine)) return 'land';
  if (/\bCreature\b/i.test(typeLine)) return 'creature';
  if (/Enchantment.*\bAura\b/i.test(typeLine)) return 'aura';
  if (/\bSorcery\b/i.test(typeLine)) return 'sorcery';
  if (/\bInstant\b/i.test(typeLine)) return 'instant';
  return null;
}

/** 把一行文本拆成多个关键字异能；如果该行全是关键字词语则返回数组，否则 null。 */
function parseKeywordLine(line: string): CardAbility[] | null {
  // 按逗号/分号拆，忽略空段
  const tokens = line.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const keywords: KeywordId[] = [];
  for (const t of tokens) {
    const id = KEYWORD_WORD[t];
    if (!id) return null;
    keywords.push(id);
  }
  return keywords.map((keyword) => ({ type: 'KEYWORD' as const, keyword }));
}

// ---------- 效果识别 ----------

const ONE_CHAR_MANA: Record<string, ManaSymbol> = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C' };

/** 把效果文字（冒号之后的部分）解析成结构化效果；无法识别返回 UNKNOWN。 */
function parseEffect(text: string): AbilityEffect {
  // Add {W} / Add {C} / Add {2}
  const addMana = text.match(/Add \{([WUBRG])\}\.?$/);
  if (addMana) return { kind: 'ADD_MANA', color: ONE_CHAR_MANA[addMana[1]], amount: 1 };
  const addGeneric = text.match(/Add \{(\d)\}\.?$/);
  if (addGeneric) return { kind: 'ADD_MANA', color: 'C', amount: Number(addGeneric[1]) };

  // +N/+N 增益（活化/静态/法术通用）
  const pt = text.match(/\+(\d+)\/\+(\d+)/);
  if (pt) {
    const duration = /until end of turn/.test(text) ? 'ENDOF_TURN' : 'PERMANENT';
    return {
      kind: 'POWER_TOUGHNESS',
      powerMod: Number(pt[1]),
      toughnessMod: Number(pt[2]),
      duration,
    };
  }

  // Deal N damage
  const damage = text.match(/Deal (\d+) damage/);
  if (damage) return { kind: 'DAMAGE', amount: Number(damage[1]) };

  // Draw N cards
  const draw = text.match(/Draw (\d+) card/i);
  if (draw) return { kind: 'DRAW', amount: Number(draw[1] === 'a' ? 1 : draw[1]) };

  // You gain N life
  const life = text.match(/gain (\d+) life/i);
  if (life) return { kind: 'LIFEGAIN', amount: Number(life[1]) };

  // Destroy target <type>
  const destroy = text.match(/Destroy target (...+?)\.?$/i);
  if (destroy) return { kind: 'DESTROY', what: destroy[1] };

  // Enchant creature（灵气结界文本）
  const enchant = text.match(/^Enchant (...+?)\.?$/i);
  if (enchant) return { kind: 'AURA', target: enchant[1].toLowerCase() };

  return { kind: 'UNKNOWN', text };
}

/** 解析启动式异能的费用前缀。 */
function parseActivatedCost(prefix: string): ActivatedCost | null {
  const trimmed = prefix.trim();
  if (trimmed === '{T}') return { type: 'TAP' };
  if (/[\{\}]/.test(trimmed)) return { type: 'MANA', cost: trimmed };
  return null;
}

// ---------- 行识别 ----------

/** 触发时机的触发介词片段。 */
function detectTrigger(text: string): TriggerInfo | null {
  if (/\benters the battlefield\b/i.test(text)) return { kind: 'ETB' };
  if (/^when\b/i.test(text) && /\benters\b/i.test(text)) return { kind: 'ETB' };
  if (/^At the beginning of your upkeep,/i.test(text)) return { kind: 'UPKEEP' };
  if (/^At the beginning of your end step,/i.test(text)) return { kind: 'END_STEP' };
  return null;
}

/** 返回布尔：该行是否为纯提醒文字/空行（跳过去，不影响 supported）。 */
function isReminderOrEmpty(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  return REMINDER_RE.test(t);
}

/**
 * 解析单个 Oracle 行。
 * `isSpell` 为 true（法术/瞬间）时，普通效果行建模为 SPELL，否则建模为 STATIC。
 * 返回 null 表示该行无法识别（→ 整卡不支持）；返回 { abilities, skip } 表示成功。
 */
function parseLine(line: string, isSpell: boolean): { abilities: CardAbility[]; skip: boolean } | null {
  if (isReminderOrEmpty(line)) return { abilities: [], skip: true };

  // 关键字行
  const kw = parseKeywordLine(line.trim());
  if (kw) return { abilities: kw, skip: false };

  // 触发式异能
  const trigger = detectTrigger(line);
  if (trigger && trigger.kind !== 'UNKNOWN') {
    const body = line.replace(/^.*?(enters the battlefield,|enters,|your upkeep,|your end step,)/, '');
    const effect = parseEffect(body.trim());
    if (effect.kind === 'UNKNOWN') return null;
    return { abilities: [{ type: 'TRIGGERED', trigger, effect }], skip: false };
  }

  // 启动式异能：`Cost: Effect`
  const activated = line.match(/^(.+?):\s+(.+)$/);
  if (activated) {
    const cost = parseActivatedCost(activated[1]);
    if (cost) {
      const effect = parseEffect(activated[2].trim());
      if (effect.kind === 'UNKNOWN') return null;
      return { abilities: [{ type: 'ACTIVATED', cost, effect }], skip: false };
    }
  }

  // 静态/法术效果（无冒号、非关键字的简单效果行）
  const staticEffect = parseEffect(line.trim());
  if (staticEffect.kind !== 'UNKNOWN') {
    const type: CardAbility['type'] = isSpell ? 'SPELL' : 'STATIC';
    return { abilities: [{ type, effect: staticEffect }] as CardAbility[], skip: false };
  }

  return null;
}

/**
 * 解析一张 Scryfall 卡。任何一行无法识别或命中硬机制 → supported=false（card=null）。
 */
export function parseScryfallCard(raw: ScryfallCardRaw): ParseCardResult {
  const oracle = (raw.oracle_text ?? '').replace(/\r/g, '');
  const typeLine = raw.type_line ?? '';

  const hard = hasHardMechanics(raw, oracle);
  if (hard) return { card: null, supported: false, reason: hard };

  const category = classifyCategory(typeLine);
  if (!category) return { card: null, supported: false, reason: `不支持的类型行: "${typeLine}"` };

  // 法术力费用含 {X}：首版无法简单计算费用，过滤
  const manaCost = raw.mana_cost ?? null;
  if (category !== 'land' && (manaCost ?? '').includes('{X}')) {
    return { card: null, supported: false, reason: '费用含 {X}' };
  }

  // 拆解能力行
  const abilities: CardAbility[] = [];
  const lines = oracle.length ? oracle.split('\n') : [];
  const isSpell = category === 'sorcery' || category === 'instant';
  for (const line of lines) {
    const parsed = parseLine(line, isSpell);
    if (parsed === null) {
      return { card: null, supported: false, reason: `无法解析能力行: "${line}"` };
    }
    abilities.push(...parsed.abilities);
  }

  // 基本地：Oracle 文本是提醒文字形式，会被跳过，这里按副类别补齐产费异能
  if (category === 'land') {
    const subtype = basicLandSubtype(typeLine);
    const hasMana = abilities.some((a) => a.type === 'ACTIVATED' && a.effect.kind === 'ADD_MANA');
    if (subtype && !hasMana) {
      abilities.push({
        type: 'ACTIVATED',
        cost: { type: 'TAP' },
        effect: { kind: 'ADD_MANA', color: BASIC_LAND_MANA[subtype], amount: 1 },
      });
    }
  }

  // 生物必须有数值 P/T
  let power: number | undefined;
  let toughness: number | undefined;
  if (category === 'creature') {
    if (raw.power == null || raw.toughness == null || /[^\d]/.test(raw.power) || /[^\d]/.test(raw.toughness)) {
      return { card: null, supported: false, reason: '生物 P/T 非数值' };
    }
    power = Number(raw.power);
    toughness = Number(raw.toughness);
  }

  const card: Card = {
    id: raw.id,
    name: raw.name ?? '',
    manaCost,
    typeLine,
    colors: raw.colors ?? [],
    category,
    power,
    toughness,
    abilities,
    oracleText: oracle,
    imageUris: raw.image_uris
      ? { normal: raw.image_uris.normal ?? '', large: raw.image_uris.large ?? '' }
      : undefined,
  };

  return { card, supported: true };
}

/** 供 ESM 引用的常量（便于测试 KEYWORDS 覆盖）。 */
export { KEYWORDS };