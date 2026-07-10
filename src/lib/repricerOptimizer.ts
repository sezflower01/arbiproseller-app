/**
 * Pure function that calculates optimal repricer settings
 * based on the number of active ASINs.
 */
export interface OptimizedSettings {
  batchSize: number;
  interval: number;
  snapshotTtl: number;
  fullCycleMinutes: number;
  cycleLabel: string;
  repricingsPerDay: number;
}

export function calculateOptimizedSettings(activeAsinCount: number): OptimizedSettings {
  const count = activeAsinCount;
  let batchSize: number;
  let interval: number;
  let snapshotTtl: number;

  if (count <= 500) {
    batchSize = 100; interval = 10; snapshotTtl = 60;
  } else if (count <= 1000) {
    batchSize = 200; interval = 10; snapshotTtl = 45;
  } else if (count <= 2000) {
    batchSize = 300; interval = 10; snapshotTtl = 30;
  } else if (count <= 4000) {
    batchSize = 400; interval = 10; snapshotTtl = 20;
  } else {
    batchSize = 500; interval = 10; snapshotTtl = 15;
  }

  const cyclesNeeded = Math.ceil(count / batchSize);
  const fullCycleMinutes = cyclesNeeded * interval;
  const repricingsPerDay = count > 0 ? Math.floor((24 * 60) / fullCycleMinutes) : 0;

  let cycleLabel: string;
  if (fullCycleMinutes < 60) {
    cycleLabel = `~${fullCycleMinutes} min`;
  } else {
    const hrs = (fullCycleMinutes / 60).toFixed(1);
    cycleLabel = `~${hrs} hrs`;
  }

  return { batchSize, interval, snapshotTtl, fullCycleMinutes, cycleLabel, repricingsPerDay };
}
