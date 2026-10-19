/** Fixed simulation rate. Never derive anything in the sim from wall clock time. */
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
/** Physics substeps per tick (suspension and tire stability). */
export const SUBSTEPS = 2;
