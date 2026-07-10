// Strategy state — UI labels, colors, and business descriptions
// Mapped 1:1 to public.repricer_strategy_state enum.

export type StrategyState =
  | 'profit_max'
  | 'competitive_recovery'
  | 'inventory_liquidation'
  | 'buybox_defense'
  | 'velocity_boost'
  | 'aged_pressure'
  | 'clearance';

export interface StrategyMeta {
  label: string;             // Operator-safe label (Simple Mode)
  short: string;             // Short chip text
  description: string;       // 1-line business description
  tone: 'healthy' | 'info' | 'review' | 'urgent';
}

export const STRATEGY_META: Record<StrategyState, StrategyMeta> = {
  profit_max: {
    label: 'Profit Maximization',
    short: 'Profit Max',
    description: 'Healthy listing — repricer is protecting margin.',
    tone: 'healthy',
  },
  competitive_recovery: {
    label: 'Competitive Recovery',
    short: 'Recovering',
    description: 'Priced above the market — closing the gap to win the Buy Box.',
    tone: 'info',
  },
  buybox_defense: {
    label: 'Buy Box Defense',
    short: 'Defending BB',
    description: 'You own the Buy Box — holding price and reacting fast to threats.',
    tone: 'info',
  },
  velocity_boost: {
    label: 'Sales Velocity Boost',
    short: 'Boost',
    description: 'Sales slowing — slightly more aggressive to drive units.',
    tone: 'review',
  },
  aged_pressure: {
    label: 'Aged Inventory Pressure',
    short: 'Aged',
    description: 'Stock aging (30+ days no sale) — softening price.',
    tone: 'review',
  },
  inventory_liquidation: {
    label: 'Inventory Liquidation',
    short: 'Liquidating',
    description: 'Heavy stock — pushing harder for sales.',
    tone: 'review',
  },
  clearance: {
    label: 'Clearance Mode',
    short: 'Clearance',
    description: 'Aged + heavy stock — must move units. Maximum price relaxation.',
    tone: 'urgent',
  },
};

export function strategyMeta(state?: string | null): StrategyMeta {
  const key = (state ?? 'profit_max') as StrategyState;
  return STRATEGY_META[key] ?? STRATEGY_META.profit_max;
}

export function strategyToneClasses(tone: StrategyMeta['tone']): string {
  switch (tone) {
    case 'urgent':
      return 'bg-[hsl(var(--status-urgent)/0.12)] text-[hsl(var(--status-urgent))] border-[hsl(var(--status-urgent)/0.30)]';
    case 'review':
      return 'bg-[hsl(var(--status-review)/0.12)] text-[hsl(var(--status-review))] border-[hsl(var(--status-review)/0.30)]';
    case 'info':
      return 'bg-[hsl(var(--status-info)/0.12)] text-[hsl(var(--status-info))] border-[hsl(var(--status-info)/0.30)]';
    case 'healthy':
    default:
      return 'bg-[hsl(var(--status-healthy)/0.12)] text-[hsl(var(--status-healthy))] border-[hsl(var(--status-healthy)/0.30)]';
  }
}
