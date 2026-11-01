import type { ComponentType } from 'react';
import type { WidgetId } from '../content/schema';
import { BlockerVsStatus, Endings, Keys, SameFinding, TickCycle } from './basic';
import { Attempts, Deadline, Escalation, Hold, SortFinding } from './core';
import { FrameWidget, PlanShape } from './live';

const WIDGETS: Record<WidgetId, ComponentType> = {
  'tick-cycle': TickCycle,
  'same-finding': SameFinding,
  keys: Keys,
  deadline: Deadline,
  'blocker-vs-status': BlockerVsStatus,
  'sort-finding': SortFinding,
  attempts: Attempts,
  hold: Hold,
  escalation: Escalation,
  endings: Endings,
  frame: FrameWidget,
  'plan-shape': PlanShape,
};

export function Widget({ id }: { id: WidgetId }) {
  const W = WIDGETS[id];
  return <W />;
}
