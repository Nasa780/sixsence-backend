/** Découpage du tableau de bord de l'activité, sans accès à la base (testé dans activityPolicy.test.ts). */

export const ACTIVITY_PERIODS = [7, 30] as const;
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

export interface ActivityDay {
  day: string;
  visitors: number;
  signups: number;
  ranked: number;
  division: number;
}

export interface Trend {
  current: number;
  previous: number;
}

/** Période demandée (7 ou 30 jours) ; 30 jours pour toute autre valeur. */
export function parsePeriod(value: unknown): ActivityPeriod {
  return ACTIVITY_PERIODS.find((period) => String(period) === String(value)) ?? 30;
}

const sum = (rows: ActivityDay[], pick: (row: ActivityDay) => number) => rows.reduce((total, row) => total + pick(row), 0);

/** Sépare la période affichée de la précédente, et calcule les chiffres clés des deux. */
export function summarize(rows: ActivityDay[], period: number) {
  const current = rows.slice(-period);
  const previous = rows.slice(-period * 2, -period);
  const trend = (pick: (row: ActivityDay) => number): Trend => ({ current: sum(current, pick), previous: sum(previous, pick) });
  return {
    days: current,
    trends: {
      visitors: trend((row) => row.visitors),
      signups: trend((row) => row.signups),
      matches: trend((row) => row.ranked + row.division),
    },
  };
}
