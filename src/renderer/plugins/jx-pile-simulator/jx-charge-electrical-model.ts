import type { JxPileOrder, JxTopologyPile } from './types'

/** 单次采样：物理量（V / A / kWh / kW），用于 0x25 / 0x30 / 0x0a 一致输出 */
export interface JxChargeElectricalSample {
  tick: number
  /** BCL 电压需求 V */
  bclVoltageV: number
  /** BCL 电流需求 A（可高于桩能力，体现 BMS 诉求） */
  bclCurrentA: number
  /** BCS 侧电压 V（略低于桩输出） */
  bcsVoltageV: number
  /** BCS 侧电流 A（略低于桩输出电流） */
  bcsCurrentA: number
  soc: number
  /** 桩直流输出电压 V（跟踪需求，电流受额定功率限制） */
  pileVoltageV: number
  /** 桩直流输出电流 A */
  pileCurrentA: number
  /** 桩直流输出功率 kW */
  powerKw: number
  /** 截至本周期累计充电量 kWh（与积分一致） */
  energyKwh: number
}

export interface JxChargeElectricalRuntime {
  tick: number
  energyKwh: number
  lastSample: JxChargeElectricalSample | null
}

export function createInitialChargeRuntime(): JxChargeElectricalRuntime {
  return { tick: 0, energyKwh: 0, lastSample: null }
}

/**
 * 直流充电简化模型：BMS 需求功率可高于桩额定，桩输出取 min(需求, 额定)；
 * P=U×I 在输出侧自洽；BCS 略低于桩端体现线损/内阻。
 */
function computeSampleCore(
  tick: number,
  energyKwh: number,
  _order: JxPileOrder,
  pile: JxTopologyPile,
): Omit<JxChargeElectricalSample, 'energyKwh'> {
  const pileRatedKw = Math.max(30, pile.pilePowerKw ?? 120)
  const ratedW = pileRatedKw * 1000

  const phase = tick < 8 ? 'startup' : tick < 65 ? 'steady' : 'tail'
  const phaseRamp =
    phase === 'startup' ? 0.12 + tick * 0.09 : phase === 'steady' ? 1 : Math.max(0.12, 0.5 - (tick - 65) * 0.018)

  const soc = Math.min(100, Math.max(5, Math.round((tick / 72) * 94 + 6)))
  const taper = Math.max(0.1, (100 - soc) / 100)

  /** BMS 期望功率（可短时高于桩额定，用于体现「需求 > 能力」） */
  const pBmsWant = Math.min(ratedW * 1.35, 420_000) * phaseRamp * taper * (phase === 'tail' ? 0.48 : 1)

  /** 需求电压随 SOC 升高略抬升，模拟末段高压平台 */
  const vBcl = Math.min(750, Math.max(280, 320 + soc * 4.0 + (phase === 'startup' ? tick * 6 : 0)))

  const iBcl = Math.min(500, Math.max(8, pBmsWant / Math.max(220, vBcl)))

  /** 桩额定下最大电流：P_rated ≈ V×I */
  const iMaxByRated = ratedW / Math.max(220, vBcl)
  const vOut = vBcl
  const iOut = Math.min(iBcl, iMaxByRated)

  const irDrop = 3.5 + (iOut / 140) * 4.5
  const vBcs = Math.max(200, vOut - irDrop)
  const iBcs = Math.max(0, iOut * 0.988 - 0.4)

  const powerKw = (vOut * iOut) / 1000

  return {
    tick,
    bclVoltageV: vBcl,
    bclCurrentA: iBcl,
    bcsVoltageV: vBcs,
    bcsCurrentA: iBcs,
    soc,
    pileVoltageV: vOut,
    pileCurrentA: iOut,
    powerKw,
  }
}

/** 不推进 tick/能量，用于遥测在首帧前或间隙的预览 */
export function peekJxChargeElectricalSample(order: JxPileOrder, pile: JxTopologyPile, tickGuess: number): JxChargeElectricalSample {
  const t = Math.max(1, Math.min(500, Math.floor(tickGuess)))
  const core = computeSampleCore(t, 0, order, pile)
  return { ...core, energyKwh: 0 }
}

/**
 * 推进一个工作信息周期：tick+1，按桩输出功率积分电量，并刷新 lastSample。
 */
export function advanceJxChargeElectricalRuntime(
  runtime: JxChargeElectricalRuntime,
  order: JxPileOrder,
  pile: JxTopologyPile,
  dtSec: number,
): JxChargeElectricalSample {
  runtime.tick += 1
  const core = computeSampleCore(runtime.tick, runtime.energyKwh, order, pile)
  const dt = Math.max(1, dtSec)
  const incrementKwh = (core.pileVoltageV * core.pileCurrentA * dt) / 3_600_000
  runtime.energyKwh += incrementKwh

  const sample: JxChargeElectricalSample = {
    ...core,
    energyKwh: runtime.energyKwh,
    powerKw: (core.pileVoltageV * core.pileCurrentA) / 1000,
  }
  runtime.lastSample = sample
  return sample
}
