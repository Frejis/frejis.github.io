// power.js — an illustrative battery-life model, not a datasheet simulation.
// Pure, no DOM. Every constant below is a stated assumption, not a measured
// fact about any real Kamstrup product; see the README for why these numbers
// are defensible orders of magnitude rather than precise.

/** Assumptions, all explicit and overridable. Units in the name of each key. */
export const DEFAULT_ASSUMPTIONS = {
  // Sub-GHz LPWAN-class radio, e.g. wireless M-Bus / LoRa territory.
  bitRateBps: 4800,
  // Fixed cost per transmission for the radio to wake, settle and key up,
  // independent of payload size — this is why a smaller payload helps less
  // than its byte count alone suggests, and the model says so honestly.
  wakeOverheadSeconds: 0.015,
  txCurrentMa: 35,
  // Deep sleep between transmissions. Microcontroller + RTC, radio off.
  sleepCurrentUa: 2.5,
  batteryCapacityMah: 2400, // a single AA-sized lithium primary cell, roughly
  // Lithium thionyl chloride (Li-SOCl2) primary cells — the usual choice for
  // multi-year meter deployments — lose capacity to self-discharge even
  // sitting idle, on the order of 1%/year (order-of-magnitude figure from
  // vendor datasheets, e.g. Tadiran/Saft bulletins on passivation and
  // storage loss; see the README). Without this term the model lets battery
  // life grow without bound as the transmit interval increases, which no
  // real cell does — self-discharge eventually dominates and caps it.
  selfDischargeRatePerYear: 0.01,
  secondsPerYear: 365.25 * 24 * 3600,
};

/** Airtime in seconds to put `frameBytes` on air at `bitRateBps`, plus wake overhead. */
export function airtimeSeconds(frameBytes, assumptions = DEFAULT_ASSUMPTIONS) {
  const { bitRateBps, wakeOverheadSeconds } = assumptions;
  return wakeOverheadSeconds + (frameBytes * 8) / bitRateBps;
}

/**
 * Expected battery life in years for a meter that transmits a frame of
 * `frameBytes` every `intervalSeconds`, and otherwise sleeps.
 *
 * Energy model: milliamp-hours per year = (transmit current x airtime x
 * transmissions/year) + (sleep current x hours/year) + (self-discharge rate
 * x rated capacity). All three terms are in mAh; the battery is exhausted
 * when their sum times the number of years equals its rated capacity. The
 * self-discharge term does not depend on transmit interval, which is exactly
 * why it is the one that matters at long intervals: as transmissions become
 * rare the other two terms shrink towards zero but self-discharge does not,
 * so life asymptotes to batteryCapacityMah / (selfDischargeRatePerYear x
 * batteryCapacityMah) = 1 / selfDischargeRatePerYear instead of growing
 * without bound.
 */
export function batteryLifeYears(frameBytes, intervalSeconds, assumptions = DEFAULT_ASSUMPTIONS) {
  const { txCurrentMa, sleepCurrentUa, batteryCapacityMah, selfDischargeRatePerYear, secondsPerYear } = assumptions;
  const transmissionsPerYear = secondsPerYear / intervalSeconds;
  const airtime = airtimeSeconds(frameBytes, assumptions);

  const txMahPerYear = txCurrentMa * (airtime / 3600) * transmissionsPerYear;
  const sleepMahPerYear = (sleepCurrentUa / 1000) * (secondsPerYear / 3600);
  const selfDischargeMahPerYear = batteryCapacityMah * selfDischargeRatePerYear;
  const totalMahPerYear = txMahPerYear + sleepMahPerYear + selfDischargeMahPerYear;

  return batteryCapacityMah / totalMahPerYear;
}

/** Same model, exposing the transmit/sleep/self-discharge split so the UI can show the ratio. */
export function batteryBudgetBreakdown(frameBytes, intervalSeconds, assumptions = DEFAULT_ASSUMPTIONS) {
  const { txCurrentMa, sleepCurrentUa, batteryCapacityMah, selfDischargeRatePerYear, secondsPerYear } = assumptions;
  const transmissionsPerYear = secondsPerYear / intervalSeconds;
  const airtime = airtimeSeconds(frameBytes, assumptions);
  const txMahPerYear = txCurrentMa * (airtime / 3600) * transmissionsPerYear;
  const sleepMahPerYear = (sleepCurrentUa / 1000) * (secondsPerYear / 3600);
  const selfDischargeMahPerYear = batteryCapacityMah * selfDischargeRatePerYear;
  return {
    airtimeSeconds: airtime,
    transmissionsPerYear,
    txMahPerYear,
    sleepMahPerYear,
    selfDischargeMahPerYear,
    years: batteryLifeYears(frameBytes, intervalSeconds, assumptions),
  };
}
