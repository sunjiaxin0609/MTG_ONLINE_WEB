/**
 * App —— 对战牌桌 UI（M10）。
 *
 * 布局：敌方区 / 中栏（阶段指示器 + 堆叠 + 日志）/ 己方区 + 操作栏。
 * 交互：手牌点击 → 下地或施放；己方未横置产费地点击 → 产费；
 *       宣告攻击者 / 宣告阻挡者步骤提供选择界面；让过优先权。
 */

import { useEffect, useState } from 'react';
import { useGameSocket } from './useGameSocket';
import {
  ClientCard,
  ClientPermanent,
  ClientPlayer,
  MANA_LABELS,
  ManaSymbol,
  PHASE_LABELS,
  PHASE_OF_STEP,
  PRIORITY_STEPS,
  STEP_LABELS,
  STEP_ORDER,
} from './types';

const CARD_W = 84;

// ---------- 小组件 ----------

function CardFace({
  card,
  onHover,
  small,
}: {
  card: ClientCard;
  onHover: (c: ClientCard | null) => void;
  small?: boolean;
}) {
  const width = small ? 64 : CARD_W;
  const image = card.imageUris?.normal;
  return (
    <div
      className={`cardface ${image ? '' : 'text'}`}
      style={{ width, height: width * 1.4 }}
      onMouseEnter={() => onHover(card)}
      onMouseLeave={() => onHover(null)}
    >
      {image ? (
        <img src={image} alt={card.name} />
      ) : (
        <>
          <div className="name">{card.name}</div>
          <div className="cost">{card.manaCost ?? (card.category === 'land' ? '地' : '—')}</div>
          {card.power != null && (
            <div className="pt">
              {card.power}/{card.toughness}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PermanentTile({
  perm,
  onHover,
  onClick,
  selected,
  attacking,
  blocking,
  disabled,
}: {
  perm: ClientPermanent;
  onHover: (c: ClientCard | null) => void;
  onClick?: () => void;
  selected?: boolean;
  attacking?: boolean;
  blocking?: boolean;
  disabled?: boolean;
}) {
  const classes = [
    'perm',
    perm.tapped ? 'tapped' : '',
    onClick && !disabled ? 'clickable' : '',
    selected ? 'selected' : '',
    attacking ? 'attacking' : '',
    blocking ? 'blocking' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      title={perm.card.name}
    >
      <CardFace card={perm.card} onHover={onHover} />
      {attacking && <span className="badge">攻击</span>}
      {blocking && <span className="badge block">阻挡</span>}
      {(perm.damageMarked ?? 0) > 0 && <span className="damage">-{perm.damageMarked}</span>}
    </button>
  );
}

function ManaPoolView({ pool }: { pool: Record<ManaSymbol, number> }) {
  const symbols: ManaSymbol[] = ['W', 'U', 'B', 'R', 'G', 'C'];
  return (
    <div className="manapool">
      {symbols.map((s) => (
        <span key={s} className={`mana ${pool[s] ? '' : 'zero'}`}>
          {MANA_LABELS[s]}
          {pool[s]}
        </span>
      ))}
    </div>
  );
}

function StepStrip({ step }: { step: string }) {
  return (
    <div className="stepstrip">
      {STEP_ORDER.map((s, i) => {
        const prev = i > 0 ? PHASE_OF_STEP[STEP_ORDER[i - 1]] : null;
        const startsPhase = prev !== PHASE_OF_STEP[s];
        return (
          <span
            key={s}
            title={PHASE_LABELS[PHASE_OF_STEP[s]]}
            className={['step', s === step ? 'current' : '', startsPhase ? 'phase-start' : '']
              .filter(Boolean)
              .join(' ')}
          >
            {STEP_LABELS[s]}
          </span>
        );
      })}
    </div>
  );
}

function PlayerBar({ player, isActive }: { player: ClientPlayer; isActive: boolean }) {
  return (
    <div className="player-head">
      <span className="life" data-low={player.life <= 5}>
        <span className={player.life <= 5 ? 'life low' : ''}>{player.life}</span>
      </span>
      <strong>{player.name}</strong>
      {isActive && <span className="pill on">本回合</span>}
      <span className="meta">手牌 {player.handCount} · 牌库 {player.libraryCount} · 坟场 {player.graveyard.length}</span>
      <ManaPoolView pool={player.manaPool} />
    </div>
  );
}

// ---------- 主组件 ----------

export default function App() {
  const game = useGameSocket();
  const [hover, setHover] = useState<ClientCard | null>(null);
  const [selectedAttackers, setSelectedAttackers] = useState<string[]>([]);
  const [blockTarget, setBlockTarget] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Record<string, string>>({});

  const view = game.view;
  const step = view?.step;
  const turn = view?.turn;

  // 步骤 / 回合变化时清空战斗选择
  useEffect(() => {
    setSelectedAttackers([]);
    setBlockTarget(null);
    setBlocks({});
  }, [step, turn]);

  if (!view || !game.you) {
    return (
      <div className="app loading">
        <div>正在连接对局…（{game.conn}）</div>
        {game.error && <div className="errorbar">{game.error}</div>}
      </div>
    );
  }

  const me = view.players.find((p) => p.id === game.you)!;
  const opp = view.players.find((p) => p.id !== game.you)!;
  const isMyTurn = view.activePlayerId === game.you;
  const hasPriority = view.priorityPlayerId === game.you;
  const inPriorityWindow = (PRIORITY_STEPS as readonly string[]).includes(view.step);
  const canAct = !view.isOver && hasPriority && inPriorityWindow;
  /** 无优先权窗口的步骤（重置 / 清理）只能"推进"；此时单个让过即推进。 */
  const canPass = !view.isOver && hasPriority;
  const isMain = view.step === 'FIRST_MAIN' || view.step === 'SECOND_MAIN';
  const canPlayLand = canAct && isMyTurn && isMain && me.landsPlayedThisTurn < 1;

  const declaringAttackers = view.step === 'DECLARE_ATTACKERS' && isMyTurn && !game.attackersDeclared && !view.isOver;
  const declaringBlockers = view.step === 'DECLARE_BLOCKERS' && !isMyTurn && !game.blockersDeclared && !view.isOver;

  const isManaProducer = (perm: ClientPermanent) =>
    perm.card.category === 'land' &&
    (perm.card.abilities ?? []).some((a) => a.type === 'ACTIVATED' && a.effect?.kind === 'ADD_MANA');

  const canTapMana = (perm: ClientPermanent) => canAct && !perm.tapped && isManaProducer(perm);

  // ---------- 动作 ----------

  const clickHandCard = (index: number, card: ClientCard) => {
    if (card.category === 'land') {
      if (canPlayLand) game.send({ type: 'PLAY_LAND', handIndex: index });
      return;
    }
    if (canAct) game.send({ type: 'CAST', handIndex: index });
  };

  const clickMyPermanent = (perm: ClientPermanent) => {
    // 阻挡：先选攻击者，再点自己的生物完成配对
    if (declaringBlockers) {
      if (!blockTarget) return;
      if (perm.tapped) return;
      setBlocks((prev) => ({ ...prev, [perm.id]: blockTarget }));
      setBlockTarget(null);
      return;
    }
    // 攻击：切换选中
    if (declaringAttackers && perm.card.category === 'creature' && !perm.tapped && !perm.sick) {
      setSelectedAttackers((prev) =>
        prev.includes(perm.id) ? prev.filter((x) => x !== perm.id) : [...prev, perm.id],
      );
      return;
    }
    // 产费
    if (canTapMana(perm)) game.send({ type: 'ACTIVATE_MANA', permanentId: perm.id });
  };

  const clickOppAttacker = (perm: ClientPermanent) => {
    if (!declaringBlockers) return;
    if (!game.combat.attackers.includes(perm.id)) return;
    setBlockTarget((prev) => (prev === perm.id ? null : perm.id));
  };

  const hint = view.isOver
    ? '对局已结束'
    : declaringAttackers
      ? '宣告攻击者：点击自己的生物选择，然后点「宣告攻击者」'
      : declaringBlockers
        ? blockTarget
          ? '已选中攻击者，点击自己的生物完成阻挡'
          : '点击对方的攻击者，再点自己的生物完成阻挡'
        : canAct
          ? `你持有优先权${isMain ? '（可下地 / 施法 / 产费）' : ''}`
          : canPass
            ? '该步骤无需行动，点「推进步骤」继续'
            : '等待对手行动…';

  return (
    <div className="app">
      {/* 顶栏 */}
      <div className="topbar">
        <span className="brand">⚔ MTG Online</span>
        <span className="pill">回合 {view.turn}</span>
        <span className="pill">{PHASE_LABELS[PHASE_OF_STEP[view.step]] ?? view.phase}</span>
        <span className="pill">{STEP_LABELS[view.step] ?? view.step}</span>
        <span className="spacer" />
        <span className={`pill ${game.conn === 'open' ? 'good' : ''}`}>连接：{game.conn}</span>
      </div>

      <StepStrip step={view.step} />

      {game.error && (
        <div className="errorbar">
          <span>⚠ {game.error}</span>
          <button onClick={game.clearError}>知道了</button>
        </div>
      )}

      {/* 敌方区 */}
      <div className={`player ${isMyTurn ? '' : 'active-turn'}`}>
        <PlayerBar player={opp} isActive={!isMyTurn} />
        <div className={`battlefield ${opp.battlefield.length ? '' : 'empty'}`}>
          {opp.battlefield.map((perm) => {
            const isAttacker = game.combat.attackers.includes(perm.id);
            const isBlocker = game.combat.blocks.some((b) => b.blockerId === perm.id);
            return (
              <PermanentTile
                key={perm.id}
                perm={perm}
                onHover={setHover}
                onClick={() => clickOppAttacker(perm)}
                selected={blockTarget === perm.id}
                attacking={isAttacker}
                blocking={isBlocker}
                disabled={!(declaringBlockers && isAttacker)}
              />
            );
          })}
        </div>
      </div>

      {/* 中栏 */}
      <div className="middle">
        <div className="panel">
          <h3>堆叠（{game.stack.length}）</h3>
          <div className="stacklist">
            {game.stack.length === 0 ? (
              <span className="meta">空</span>
            ) : (
              [...game.stack].reverse().map((item) => (
                <div
                  key={item.id}
                  className="stackitem"
                  onMouseEnter={() => setHover(item.card)}
                  onMouseLeave={() => setHover(null)}
                >
                  <span className="who">{item.controllerId === game.you ? '你' : '对手'}</span>
                  <span>{item.card.name}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <h3>对局日志</h3>
          <div className="log">
            {game.events
              .slice(-60)
              .reverse()
              .map((e) => (
                <div key={e.seq} className="logline">
                  <span className="by">[{e.by === game.you ? '你' : e.by === 'system' ? '系统' : '对手'}]</span>{' '}
                  {e.message}
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* 己方区 */}
      <div className={`player ${isMyTurn ? 'active-turn' : ''}`}>
        <PlayerBar player={me} isActive={isMyTurn} />
        <div className={`battlefield ${me.battlefield.length ? '' : 'empty'}`}>
          {me.battlefield.map((perm) => {
            const isAttacker = game.combat.attackers.includes(perm.id);
            const isBlocker = game.combat.blocks.some((b) => b.blockerId === perm.id);
            return (
              <PermanentTile
                key={perm.id}
                perm={perm}
                onHover={setHover}
                onClick={() => clickMyPermanent(perm)}
                selected={selectedAttackers.includes(perm.id) || Boolean(blocks[perm.id])}
                attacking={isAttacker}
                blocking={isBlocker}
                disabled={
                  !(declaringAttackers || declaringBlockers || canTapMana(perm))
                }
              />
            );
          })}
        </div>

        <div className="hand">
          {me.hand.map((card, index) => (
            <button
              key={`${card.id}-${index}`}
              type="button"
              className="handcard"
              onClick={() => clickHandCard(index, card)}
              title={card.name}
            >
              <CardFace card={card} onHover={setHover} />
            </button>
          ))}
        </div>
      </div>

      {/* 操作栏 */}
      <div className="actionbar">
        <button className="primary" disabled={!canPass} onClick={() => game.send({ type: 'PASS' })}>
          {inPriorityWindow ? '让过优先权' : '推进步骤'}
        </button>

        {declaringAttackers && (
          <button
            className="primary"
            onClick={() => game.send({ type: 'DECLARE_ATTACKERS', attackerIds: selectedAttackers })}
          >
            宣告攻击者（{selectedAttackers.length}）
          </button>
        )}

        {declaringBlockers && (
          <>
            <button
              className="primary"
              onClick={() =>
                game.send({
                  type: 'DECLARE_BLOCKERS',
                  blocks: Object.entries(blocks).map(([blockerId, attackerId]) => ({ blockerId, attackerId })),
                })
              }
            >
              宣告阻挡者（{Object.keys(blocks).length}）
            </button>
            <button
              disabled={!blockTarget && Object.keys(blocks).length === 0}
              onClick={() => {
                setBlockTarget(null);
                setBlocks({});
              }}
            >
              清除选择
            </button>
          </>
        )}

        <span className={`hint ${canPass || declaringAttackers || declaringBlockers ? '' : 'wait'}`}>{hint}</span>
      </div>

      {/* 悬停大图 */}
      {hover && (
        <div className="hoverpreview">
          {hover.imageUris?.large || hover.imageUris?.normal ? (
            <img src={hover.imageUris?.large ?? hover.imageUris?.normal} alt={hover.name} />
          ) : (
            <div className="fallback">
              <strong>{hover.name}</strong>
              <div className="meta">{hover.typeLine}</div>
              <div className="meta">{hover.manaCost ?? '无费用'}</div>
              <div>{hover.oracleText}</div>
            </div>
          )}
        </div>
      )}

      {/* 结束覆盖层 */}
      {view.isOver && (
        <div className="overlay">
          <div className="box">
            <h2>{view.winnerId === game.you ? '🏆 你赢了！' : view.winnerId === null ? '平局' : '💀 你输了'}</h2>
            <div className="meta">
              第 {view.turn} 回合结束 · 你的生命 {me.life} / 对手生命 {opp.life}
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="primary" onClick={game.restart}>
                再来一局
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
