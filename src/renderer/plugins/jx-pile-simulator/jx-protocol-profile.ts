/**
 * 桩 `protocolId` → 报文线格式分支（V2.24 / V2.25 在 `0x23` 等处字段不同）。
 * `0x21` 在服务端 `StartResultHandler224` 中对 **V2.24～V2.25** 共用同一套 `CM21Data` 解析，`startElect` 一律按 `CovertConst.FOUR_POINT`（0.0001kWh），见 `cm21StartElect*`。
 */
import {
  order23WireProfileFromProtocolId,
  type JxOrder23WireProfile,
} from './jx-order23-wire-map'

export { order23WireProfileFromProtocolId, type JxOrder23WireProfile }

export type JxProtocolWireProfile = JxOrder23WireProfile

/** 与 `StartResultHandler224`：`startElect` 原始 int ×0.0001kWh */
export function cm21StartElectRawFromKwh(kwh: number): number {
  return Math.max(0, Math.min(0xffffffff, Math.round(kwh * 10000)))
}

export function cm21StartElectKwhFromRaw(raw: number): number {
  return raw / 10000
}
